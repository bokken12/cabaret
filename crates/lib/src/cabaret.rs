use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    path::Path,
};

use cabaret_config::{Hints, Prefix};
use cabaret_page::{DiffView, Home, HomeGraph, HomeNode, HomeSection, NextStep, Page, Route, TabCounts};
use cabaret_transaction::{Branch, BranchOp, Metadata, Status, Store, Transaction, WorkspaceOp, pathspec_search};
use cabaret_types::{
    ChangeId, ChangeIdRef, ChangeSnapshot, ChangedFile, FileDiff, FileVersion, Identity, LineCounts, Pathspec,
    RepoPath, Result, Reviewing, RevisionId, ViewDiff,
    safeguard::{Safeguard, SafeguardKind},
};
use jiff::ZonedDateTime;
use nonempty_collections::{NEBTreeSet, NonEmptyIterator, nebts};

/// Marks a project directory, one holding the bare repository `.bare` beside one workspace per
/// change, as the repository's own: git commands work from it and nothing else shares it.
const GITFILE: &str = "gitdir: ./.bare\n";

/// Beyond this many files a files page skips counting lines, so that a huge change lists quickly.
const COUNTED_FILES: usize = 100;

/// What [`Cabaret::rebase`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "napi", napi_derive::napi(object, object_from_js = false))]
pub struct Rebase {
    /// The parents merged in; empty when the change already contained them all.
    pub merged: BTreeSet<ChangeId>,
    /// Files the last merge left holding conflict markers, which stopped the rebase there.
    pub conflicts: BTreeSet<RepoPath>,
    /// Parents not reached because of the conflicts; rebasing again after resolving them continues.
    pub remaining: BTreeSet<ChangeId>,
}

/// Cabaret provides the external-facing interface, with actions at the level a porcelain performs.
pub struct Cabaret {
    pub(crate) store: Store,
}

impl From<gix::ThreadSafeRepository> for Cabaret {
    fn from(repo: gix::ThreadSafeRepository) -> Self { Self { store: repo.into() } }
}

// TODO-someday(joel): it's a bit awkward to me how this file often mixes together metadata-level and file-level
// operations among others, I might want to either
// 1. Add a layer of abstraction on top of gix so that git operations are concisely described next to metadata edits
//    without either getting complexity?
// 2. Split up where these different pieces of logic live by file and/or impl block?
// 3. Other cleaning that allows this file to be more readable/skimmable?
impl Cabaret {
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> { Ok(Self { store: Store::open(dir)? }) }

    /// A new repository at `dir`, made if need be, empty or cloned from `from`. An empty
    /// directory becomes a project directory, the bare repository `.bare` with room beside it
    /// for one workspace per change. One with contents becomes the main workspace of an empty
    /// repository, as `git init` makes; a clone needs an empty one.
    pub fn init(dir: &Path, from: Option<&str>) -> Result<()> {
        let dir = std::path::absolute(dir)?;
        fs::create_dir_all(&dir)?;
        if dir.read_dir()?.next().is_some() {
            if from.is_some() {
                Err(format!("{} is not empty", dir.display()))?;
            }
            gix::init(&dir)?;
            return Ok(());
        }
        match from {
            Some(url) => {
                // Bare clones otherwise mirror origin's branches as local ones; fetch keeps
                // those apart as remote-tracking refs.
                let (repo, _) = gix::prepare_clone_bare(url, dir.join(".bare"))?
                    .configure_remote(|remote| {
                        remote.with_refspecs(["+refs/heads/*:refs/remotes/origin/*"], gix::remote::Direction::Fetch)
                    })
                    .fetch_only(gix::progress::Discard, &gix::interrupt::IS_INTERRUPTED)?;
                track_origin_head(&repo)?;
            }
            None => {
                gix::init_bare(dir.join(".bare"))?;
            }
        }
        fs::write(dir.join(".git"), GITFILE)?;
        Ok(())
    }

    // Change operations

    pub fn changes(&self) -> Result<Vec<ChangeId>> { self.store.query(|txn| txn.changes()) }

    /// The title of every change that has one.
    pub fn titles(&self) -> Result<BTreeMap<ChangeId, String>> {
        self.store.query(|txn| {
            let mut titles = BTreeMap::new();
            for change in txn.changes()? {
                if let Some(title) = &txn.metadata(&change)?.title {
                    titles.insert(change, title.clone());
                }
            }
            Ok(titles)
        })
    }

    pub fn current_change(&self) -> Result<ChangeId> { self.store.query(|txn| txn.current_change()) }

    pub fn trunk(&self) -> Result<ChangeId> { self.store.query(|txn| txn.default_branch()) }

    pub fn resolve(&self, spec: &str) -> Result<RevisionId> { self.store.query(|txn| txn.resolve(spec)) }

    pub fn title(&self, change_id: &ChangeIdRef) -> Result<Option<String>> {
        self.store.query(|txn| Ok(txn.metadata(change_id)?.title.clone()))
    }

    pub fn snapshot(&self, change_id: &ChangeIdRef) -> Result<ChangeSnapshot> {
        self.store.query(|txn| txn.snapshot(change_id))
    }

    /// The open changes with `change_id` as a parent, the inverse of `ChangeSnapshot::parents`.
    /// Archived changes are left out: every landed change keeps what it landed into forever.
    pub fn children(&self, change_id: &ChangeIdRef) -> Result<BTreeSet<ChangeId>> {
        self.store.query(|txn| open_children(txn, change_id))
    }

    pub fn blob(&self, revision: RevisionId, path: &RepoPath) -> Result<Option<FileVersion>> {
        self.store.query(|txn| txn.blob(revision, path))
    }

    pub fn base(&self, change_id: &ChangeIdRef) -> Result<RevisionId> {
        self.store.query(|txn| txn.branch(change_id)?.base(&txn.metadata(change_id)?.parents))
    }

    pub fn changed_files(&self, change_id: &ChangeIdRef, pathspecs: &[Pathspec]) -> Result<Vec<ChangedFile>> {
        self.store.query(|txn| txn.branch(change_id)?.changed_files(&txn.metadata(change_id)?.parents, pathspecs))
    }

    /// The page `route` names, as this repository's identity sees it. A change's pages carry its
    /// tabs under their heading, which names the change the tabs are of.
    pub fn page(&self, route: &Route) -> Result<Page> {
        let (change_id, view, mut page) = match route {
            Route::Home { section } => return Page::home_section(&self.home(&self.identity()?)?, *section),
            Route::Show { change } => (change, None, self.show_page(change)?),
            Route::Files { view, change } => (change, Some(*view), self.files_page(change, *view, &[])?),
        };
        page.insert(1, self.change_tabs(change_id, view)?);
        Ok(page)
    }

    pub fn show_page(&self, change_id: &ChangeIdRef) -> Result<Page> {
        let hints = self.config::<Hints>()?.unwrap_or_default();
        self.store.query(|txn| {
            let change = txn.snapshot(change_id)?;
            let workspace = match &change.workspace {
                Some(workspace) => Some(txn.workspace(workspace.to_ref())?.path()),
                None => None,
            };
            Ok(Page::show(change_id, &change, workspace, next_step(txn, change_id)?.as_ref(), &txn.identity()?, hints))
        })
    }

    /// The files of `change_id` this repository's identity has left to review, restricted to
    /// `pathspecs` (all when empty); see `Branch::review_files`.
    pub fn review_files(&self, change_id: &ChangeIdRef, pathspecs: &[Pathspec]) -> Result<Vec<ChangedFile>> {
        self.store.query(|txn| {
            let metadata = txn.metadata(change_id)?;
            let review = metadata.review.get(&txn.identity()?).cloned().unwrap_or_default();
            txn.branch(change_id)?.review_files(&metadata.parents, &review, pathspecs)
        })
    }

    /// The files the workspace holding `change_id` has on disk that differ from the change's tip,
    /// restricted to `pathspecs` (all when empty): what [`Self::commit`] would record.
    pub fn workspace_files(&self, change_id: &ChangeIdRef, pathspecs: &[Pathspec]) -> Result<Vec<ChangedFile>> {
        let workspace_id = self.workspace_of(change_id)?;
        self.store.query(|txn| txn.workspace(workspace_id.to_ref())?.changed_files(pathspecs))
    }

    /// The files `change_id`'s `view` diffs, restricted to `pathspecs` (all when empty).
    pub fn view_files(
        &self,
        change_id: &ChangeIdRef,
        view: DiffView,
        pathspecs: &[Pathspec],
    ) -> Result<Vec<ChangedFile>> {
        match view {
            DiffView::Diff => self.changed_files(change_id, pathspecs),
            DiffView::Review => self.review_files(change_id, pathspecs),
            DiffView::Workspace => self.workspace_files(change_id, pathspecs),
        }
    }

    // TODO-someday(joel): I don't really liek page logic living here?
    pub fn files_page(&self, change_id: &ChangeIdRef, view: DiffView, pathspecs: &[Pathspec]) -> Result<Page> {
        let diff = self.view_diff(change_id, view, pathspecs)?;
        let counted = diff.files.len() <= COUNTED_FILES;
        let version = |revision: Option<RevisionId>, path: &RepoPath| -> Result<Option<FileVersion>> {
            let Some(revision) = revision else { return Ok(None) };
            Ok(Some(self.blob(revision, path)?.expect("a changed file is on the side it differs on")))
        };
        let files = diff
            .files
            .into_iter()
            .map(|FileDiff { file, before, after }| {
                let counts = match counted {
                    true => Some(LineCounts::new(
                        version(before, file.source())?.as_ref(),
                        version(after, file.path())?.as_ref(),
                    )),
                    false => None,
                };
                Ok((file, counts))
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Page::files(change_id, self.title(change_id)?.as_deref(), view, &files))
    }

    /// The files `change_id`'s `view` diffs, restricted to `pathspecs` (all when empty), with the
    /// revisions holding both sides of each, all read at once. The workspace view's after side is
    /// what the workspace has saved, as a commit on the tip that no branch holds, so that it stays
    /// as it was read.
    pub fn view_diff(&self, change_id: &ChangeIdRef, view: DiffView, pathspecs: &[Pathspec]) -> Result<ViewDiff> {
        let workspace_id = match view {
            DiffView::Workspace => Some(self.workspace_of(change_id)?),
            DiffView::Diff | DiffView::Review => None,
        };
        self.store.query(|txn| {
            let (metadata, branch) = (txn.metadata(change_id)?, txn.branch(change_id)?);
            let parents = &metadata.parents;
            let tip = branch.tip;
            let files = match view {
                DiffView::Diff => {
                    let base = branch.base(parents)?;
                    branch
                        .changed_files(parents, pathspecs)?
                        .into_iter()
                        .map(|file| FileDiff::new(file, base, tip))
                        .collect()
                }
                DiffView::Review => {
                    let review = metadata.review.get(&txn.identity()?).cloned().unwrap_or_default();
                    let mut bases = BTreeMap::new();
                    let mut files = Vec::new();
                    for file in branch.review_files(parents, &review, pathspecs)? {
                        let reviewed = review.get(file.path()).copied();
                        let base = match bases.get(&reviewed) {
                            Some(&base) => base,
                            None => *bases.entry(reviewed).or_insert(branch.review_base(parents, reviewed)?),
                        };
                        files.push(FileDiff::new(file, base, tip));
                    }
                    files
                }
                DiffView::Workspace => {
                    let workspace = txn.workspace(workspace_id.as_ref().expect("looked up above").to_ref())?;
                    // One read of the disk, so every file listed is in the saved commit.
                    let tree = workspace.saved_tree(pathspecs)?;
                    let saved = txn.commit(tree, vec![tip], change_id.as_bstr())?;
                    workspace.saved_changes(tree)?.into_iter().map(|file| FileDiff::new(file, tip, saved)).collect()
                }
            };
            Ok(ViewDiff { tip, files })
        })
    }

    /// The tabs over `change_id`'s pages, with `view`'s showing (`None` for its show page).
    fn change_tabs(&self, change_id: &ChangeIdRef, view: Option<DiffView>) -> Result<Page> {
        let count = |view| -> Result<usize> { Ok(self.view_files(change_id, view, &[])?.len()) };
        let workspace = match self.workspace_holding(change_id)? {
            Some(_) => Some(count(DiffView::Workspace)?),
            None => None,
        };
        let counts = TabCounts { diff: count(DiffView::Diff)?, review: count(DiffView::Review)?, workspace };
        Ok(Page::change_tabs(change_id, view, counts, self.config::<Hints>()?.unwrap_or_default()))
    }

    /// The id a change named `name` is created under: `name` behind the configured prefix.
    fn claim(&self, name: &str) -> Result<ChangeId> {
        self.config::<Prefix>()?.unwrap_or_default().apply(name, &ZonedDateTime::now())
    }

    /// Create a change named `name` on `parent_ids`, returning its id. Safeguards not in `allow`
    /// refuse, before anything is merged.
    pub fn create(
        &self,
        name: &str,
        parent_ids: &NEBTreeSet<ChangeId>,
        owner: &Identity,
        allow: &BTreeSet<SafeguardKind>,
    ) -> Result<ChangeId> {
        let change_id = self.claim(name)?;
        let (first, rest) = parent_ids.nonempty_iter().next();
        let tip = self.store.query(|txn| Ok(txn.branch(first)?.tip))?;
        let branches = [BranchOp::Insert { id: &change_id, tip }];
        self.store.transact(allow, &[&change_id], &branches, &[], |txn, [metadata], [branch], []| {
            for parent_id in parent_ids {
                if txn.metadata(parent_id)?.archived {
                    txn.check(Safeguard::ArchivedParents { parents: nebts![parent_id.clone()] });
                }
            }
            for parent_id in rest {
                branch.merge(txn.branch(parent_id)?, "create")?;
            }
            metadata.title = Some(name.to_owned());
            metadata.parents = parent_ids.iter().cloned().collect();
            metadata.owners = BTreeSet::from([owner.clone()]);
            Ok(())
        })?;
        Ok(change_id)
    }

    /// Create a change named `name` between `child_id` and its parents, returning its id.
    pub fn create_parent(
        &self,
        name: &str,
        child_id: &ChangeIdRef,
        owner: &Identity,
        allow: &BTreeSet<SafeguardKind>,
    ) -> Result<ChangeId> {
        let change_id = self.claim(name)?;
        // TODO(joel): currently non-atomic to build tip
        let parents = self.store.query(|txn| Ok(txn.metadata(child_id)?.parents.clone()))?;
        let mut to_merge = parents.iter();
        let first = to_merge.next().ok_or_else(|| format!("{child_id} has no base to create a parent from"))?;

        let tip = self.store.query(|txn| Ok(txn.branch(first)?.tip))?;
        let branches = [BranchOp::Insert { id: &change_id, tip }];
        self.store.transact(allow, &[&change_id, child_id], &branches, &[], |txn, [change, child], [branch], []| {
            for parent_id in to_merge {
                branch.merge(txn.branch(parent_id)?, "create")?;
            }
            change.title = Some(name.to_owned());
            change.parents.clone_from(&parents);
            change.owners = BTreeSet::from([owner.clone()]);
            child.parents = BTreeSet::from([change_id.clone()]);
            Ok(())
        })?;
        Ok(change_id)
    }

    /// Record what the workspace holding `change_id` has on disk at the paths `pathspecs` match,
    /// all when empty, as a new commit on the change, returning it. The commit is named for the
    /// change and nothing more: commits are for the computer, not for reading.
    pub fn commit(
        &self,
        change_id: &ChangeIdRef,
        pathspecs: &[Pathspec],
        allow: &BTreeSet<SafeguardKind>,
    ) -> Result<RevisionId> {
        let workspace_id = self.workspace_of(change_id)?;
        let branches = [BranchOp::Update(change_id)];
        let workspaces = [WorkspaceOp::Update { id: workspace_id.to_ref() }];
        self.store.transact(allow, &[], &branches, &workspaces, |txn, [], [branch], [workspace]| {
            if txn.metadata(change_id)?.archived {
                Err(format!("{change_id} is archived"))?;
            }
            // The workspace was found before its lock was taken, so it may have switched since.
            if workspace.change().is_none_or(|held| **held != *change_id) {
                Err(format!("{change_id} is no longer checked out in workspace {workspace_id}"))?;
            }
            // The index is only staged once nothing refuses, so a refusal leaves the workspace be.
            let tree = workspace.saved_tree(pathspecs)?;
            if tree.0 == txn.repo.find_commit(branch.tip)?.tree_id()?.detach() {
                Err(format!("{change_id} has nothing to commit"))?;
            }
            let mut committed = branch.clone();
            committed.tip = txn.commit(tree, vec![branch.tip], change_id.as_bstr())?;
            let parents = &txn.metadata(change_id)?.parents;
            let before = branch.conflicted_files(parents)?;
            let added = committed.conflicted_files(parents)?.difference(&before).cloned().collect();
            if let Some(files) = NEBTreeSet::try_from_set(added) {
                txn.check(Safeguard::Conflicted { files });
            }
            if workspace.snapshot(pathspecs)? != tree {
                Err(format!("files changed while committing to {change_id}; commit again"))?;
            }
            branch.tip = committed.tip;
            Ok(branch.tip)
        })
    }

    /// Drop what `change_id`'s workspace has on disk at the paths `pathspecs` match, all when
    /// empty, putting them back as the change's tip has them.
    pub fn discard(&self, change_id: &ChangeIdRef, pathspecs: &[Pathspec]) -> Result<()> {
        let workspace_id = self.workspace_of(change_id)?;
        let branches = [BranchOp::Update(change_id)];
        let workspaces = [WorkspaceOp::Update { id: workspace_id.to_ref() }];
        self.store.transact(&BTreeSet::new(), &[], &branches, &workspaces, |_txn, [], [_branch], [workspace]| {
            // The workspace was found before its lock was taken, so it may have switched since.
            if workspace.change().is_none_or(|held| **held != *change_id) {
                Err(format!("{change_id} is no longer checked out in workspace {workspace_id}"))?;
            }
            workspace.discard(pathspecs)
        })
    }

    /// Merge `change_id` into its one parent and archive it unless it is permanent, returning the
    /// parent. Conflicts landing in a root are errors, since a root is never searched for them:
    /// rebase and resolve them first. Safeguards not in `allow` refuse, checked last so that
    /// allowing them cannot run into an error.
    // TODO-someday(joel): an option, perhaps the default, to fix the parents of the landed
    // change's children, which are otherwise each left to fix their own.
    pub fn land(&self, change_id: &ChangeIdRef, allow: &BTreeSet<SafeguardKind>) -> Result<ChangeId> {
        let parent_id = self.store.query(|txn| landing_parent(txn, change_id))?;
        // The child's branch is declared so it cannot move between the merge and the archive.
        let branches = [BranchOp::Update(&parent_id), BranchOp::Update(change_id)];
        self.store.transact(allow, &[change_id], &branches, &[], |txn, [child], [parent, child_branch], []| {
            if child.archived {
                Err(format!("{change_id} is archived"))?;
            }
            let parents = &child.parents;
            let merged = parent.merge(child_branch, "land")?;
            let conflicts: BTreeSet<RepoPath> =
                child_branch.conflicted_files(parents)?.into_iter().chain(merged.iter().flatten().cloned()).collect();
            let parent_metadata = txn.metadata(&parent_id)?;
            let grandparents = &parent_metadata.parents;
            if !conflicts.is_empty() && grandparents.is_empty() {
                Err(format!("{change_id} would land conflicts in {parent_id}, a root; rebase and resolve first"))?;
            }

            txn.check_owner(change_id)?;
            txn.check_parents_fixed(change_id)?;
            if let Some(reviewers) = NEBTreeSet::try_from_set(unreviewed(child, child_branch, parents)?) {
                txn.check(Safeguard::Unreviewed { reviewers });
            }
            if let Some(owners) = NEBTreeSet::try_from_set(child.unendorsed()) {
                txn.check(Safeguard::Unendorsed { owners });
            }
            // A root has no diff of its own to review.
            if !grandparents.is_empty()
                && let Some(reviewers) =
                    NEBTreeSet::try_from_set(unreviewed(parent_metadata, txn.branch(&parent_id)?, grandparents)?)
            {
                txn.check(Safeguard::ParentUnreviewed { parent: parent_id.clone(), reviewers });
            }
            if merged.is_none() {
                txn.check(Safeguard::Empty { parent: parent_id.clone() });
            }
            if let Some(files) = NEBTreeSet::try_from_set(conflicts) {
                txn.check(Safeguard::Conflicted { files });
            }
            if let Some(workspace) = child_branch.workspace()?
                && txn.workspace(workspace.to_ref())?.status()? != Status::Clean
            {
                txn.check(Safeguard::Uncommitted { workspace });
            }
            if !child.permanent {
                child.archived = true;
            }
            Ok(parent_id.clone())
        })
    }

    /// Bring `change_id` up to date with `onto`, or with every parent when `onto` is `None`.
    /// Cabaret never rewrites history, so each parent's tip is merged in; a conflicting merge is
    /// committed with markers and stops the rebase there, so those are resolved before the next.
    /// Safeguards not in `allow` refuse, before anything is merged.
    pub fn rebase(
        &self,
        change_id: &ChangeIdRef,
        onto: Option<&ChangeIdRef>,
        allow: &BTreeSet<SafeguardKind>,
    ) -> Result<Rebase> {
        self.store.transact(allow, &[], &[BranchOp::Update(change_id)], &[], |txn, [], [branch], []| {
            let metadata = txn.metadata(change_id)?;
            let targets = rebase_targets(metadata, onto)?;
            txn.check_owner(change_id)?;
            txn.check_parents_fixed(change_id)?;
            if let Some(files) = NEBTreeSet::try_from_set(branch.conflicted_files(&metadata.parents)?) {
                txn.check(Safeguard::Conflicted { files });
            }
            for target in &targets {
                let parent = txn.branch(target)?;
                // A parent already merged in brings nothing, conflicts included.
                if txn.is_predecessor(parent.tip, branch.tip)? {
                    continue;
                }
                if let Some(files) = NEBTreeSet::try_from_set(parent.conflicted_files(&txn.metadata(target)?.parents)?)
                {
                    txn.check(Safeguard::ParentConflicted { parent: target.clone(), files });
                }
            }

            let mut rebase = Rebase { merged: BTreeSet::new(), conflicts: BTreeSet::new(), remaining: BTreeSet::new() };
            let mut targets = targets.into_iter();
            for parent_id in targets.by_ref() {
                if let Some(conflicts) = branch.merge(txn.branch(&parent_id)?, "rebase")? {
                    rebase.merged.insert(parent_id);
                    rebase.conflicts = conflicts;
                    if !rebase.conflicts.is_empty() {
                        break;
                    }
                }
            }
            rebase.remaining = targets.collect();
            Ok(rebase)
        })
    }

    pub fn archive(&self, change_id: &ChangeIdRef, allow: &BTreeSet<SafeguardKind>) -> Result<()> {
        self.store.update_metadata(allow, change_id, |txn, metadata| {
            if metadata.archived {
                return Ok(());
            }
            if let Some(children) = NEBTreeSet::try_from_set(open_children(txn, change_id)?) {
                txn.check(Safeguard::OpenChildren { children });
            }
            if metadata.permanent {
                txn.check(Safeguard::Permanent);
            }
            metadata.archived = true;
            Ok(())
        })
    }

    pub fn unarchive(&self, change_id: &ChangeIdRef, allow: &BTreeSet<SafeguardKind>) -> Result<()> {
        self.store.update_metadata(allow, change_id, |txn, metadata| {
            if !metadata.archived {
                return Ok(());
            }
            let mut archived = BTreeSet::new();
            for parent in &metadata.parents {
                if txn.metadata(parent)?.archived {
                    archived.insert(parent.clone());
                }
            }
            if let Some(parents) = NEBTreeSet::try_from_set(archived) {
                txn.check(Safeguard::ArchivedParents { parents });
            }
            metadata.archived = false;
            Ok(())
        })
    }

    pub fn add_owner(&self, change_id: &ChangeIdRef, owner: &Identity) -> Result<()> {
        self.store.update_metadata(&BTreeSet::new(), change_id, |_txn, metadata| {
            metadata.owners.insert(owner.clone());
            Ok(())
        })
    }

    pub fn remove_owner(
        &self,
        change_id: &ChangeIdRef,
        owner: &Identity,
        allow: &BTreeSet<SafeguardKind>,
    ) -> Result<()> {
        self.store.update_metadata(allow, change_id, |txn, metadata| {
            if !metadata.owners.remove(owner) {
                return Ok(());
            }
            if *owner != txn.identity()? {
                txn.check(Safeguard::RemovesOthers { owners: nebts![owner.clone()] });
            }
            if metadata.owners.is_empty() {
                txn.check(Safeguard::Ownerless);
            }
            Ok(())
        })
    }

    pub fn set_owners(
        &self,
        change_id: &ChangeIdRef,
        owners: &BTreeSet<Identity>,
        allow: &BTreeSet<SafeguardKind>,
    ) -> Result<()> {
        self.store.update_metadata(allow, change_id, |txn, metadata| {
            if metadata.owners == *owners {
                return Ok(());
            }
            let you = txn.identity()?;
            let others = metadata.owners.difference(owners).filter(|owner| **owner != you).cloned().collect();
            if let Some(others) = NEBTreeSet::try_from_set(others) {
                txn.check(Safeguard::RemovesOthers { owners: others });
            }
            if owners.is_empty() {
                txn.check(Safeguard::Ownerless);
            }
            metadata.owners.clone_from(owners);
            Ok(())
        })
    }

    /// Declare `parent_id` a parent of `change_id`. A parent descending from the change is an
    /// error, since the graph would cycle.
    pub fn add_parent(
        &self,
        change_id: &ChangeIdRef,
        parent_id: &ChangeIdRef,
        allow: &BTreeSet<SafeguardKind>,
    ) -> Result<()> {
        self.store.update_metadata(allow, change_id, |txn, metadata| {
            if !metadata.parents.insert(parent_id.to_owned()) {
                return Ok(());
            }
            if parent_id == change_id {
                Err(format!("{change_id} cannot be its own parent"))?;
            }
            let parent = txn.metadata(parent_id)?;
            if parent.is_descendant(change_id)? {
                Err(format!("{parent_id} descends from {change_id}, so it cannot be its parent"))?;
            }
            if parent.archived && !metadata.archived {
                txn.check(Safeguard::ArchivedParents { parents: nebts![parent_id.to_owned()] });
            }
            for other in metadata.parents.iter().filter(|other| other.as_ref() != parent_id) {
                if txn.metadata(other)?.is_descendant(parent_id)? {
                    txn.check(Safeguard::RedundantParent { parent: parent_id.to_owned(), descendant: other.clone() });
                    break;
                }
            }
            if let Some(safeguard) = no_common_ancestor(metadata)? {
                txn.check(safeguard);
            }
            Ok(())
        })
    }

    pub fn remove_parent(
        &self,
        change_id: &ChangeIdRef,
        parent_id: &ChangeIdRef,
        allow: &BTreeSet<SafeguardKind>,
    ) -> Result<()> {
        self.store.update_metadata(allow, change_id, |txn, metadata| {
            let branch = txn.branch(change_id)?;
            let before = branch.base(&metadata.parents)?;
            if !metadata.parents.remove(parent_id) {
                return Ok(());
            }
            if branch.base(&metadata.parents)? != before {
                txn.check(Safeguard::BaseMoves { removed: parent_id.to_owned() });
            }
            if metadata.parents.is_empty() {
                txn.check(Safeguard::Parentless);
            }
            if let Some(safeguard) = no_common_ancestor(metadata)? {
                txn.check(safeguard);
            }
            Ok(())
        })
    }

    /// Replace `change_id`'s archived parents with their own and drop those already an ancestor
    /// of another, see `Metadata::fixed_parents`.
    // TODO-someday(joel): refuse with `BaseMoves` when a replaced parent was archived without
    // landing, so that fixing takes its work into the diff.
    pub fn fix_parents(&self, change_id: &ChangeIdRef) -> Result<()> {
        self.store.update_metadata(&BTreeSet::new(), change_id, |_txn, metadata| {
            metadata.parents = metadata.fixed_parents()?;
            Ok(())
        })
    }

    /// Record that this repository's identity has reviewed the files of `change_id` that
    /// `pathspecs` match up to `head`, by default the change's tip, returning them. Each pathspec
    /// matches among the files left to review and those marked before, since re-marking a reviewed
    /// file is harmless, and is refused if it matches none.
    pub fn mark(
        &self,
        change_id: &ChangeIdRef,
        pathspecs: &[Pathspec],
        head: Option<RevisionId>,
    ) -> Result<BTreeSet<RepoPath>> {
        self.store.update_metadata(&BTreeSet::new(), change_id, |txn, metadata| {
            let branch = txn.branch(change_id)?;
            let revision = head.unwrap_or(branch.tip);
            let parents = metadata.parents.clone();
            let review = metadata.review.entry(txn.identity()?).or_default();
            let left = branch.review_files(&parents, review, &[])?;
            let mut files = BTreeSet::new();
            let mut unmatched = Vec::new();
            for pathspec in pathspecs {
                let mut search = pathspec_search(&txn.repo, std::slice::from_ref(pathspec))?;
                let mut included = |path: &RepoPath| search.is_included(path.as_bstr(), Some(false));
                let mut matched = BTreeSet::new();
                matched
                    .extend(left.iter().filter(|file| file.paths().any(&mut included)).map(|file| file.path().clone()));
                matched.extend(review.keys().filter(|path| included(path)).cloned());
                if matched.is_empty() {
                    unmatched.push(format!("'{}'", pathspec.0.path()));
                }
                files.append(&mut matched);
            }
            if !unmatched.is_empty() {
                Err(format!(
                    "nothing left to review or marked before in {change_id} matches {}",
                    unmatched.join(", ")
                ))?;
            }
            review.extend(files.iter().map(|file| (file.clone(), revision)));
            Ok(files)
        })
    }

    /// Record that this repository's identity approves `change_id` as a whole, which holds however
    /// the change evolves after, unlike review. Endorsing with files left to review is refused.
    pub fn endorse(&self, change_id: &ChangeIdRef, allow: &BTreeSet<SafeguardKind>) -> Result<()> {
        self.store.update_metadata(allow, change_id, |txn, metadata| {
            let you = txn.identity()?;
            let review = metadata.review.get(&you).cloned().unwrap_or_default();
            if !txn.branch(change_id)?.review_files(&metadata.parents, &review, &[])?.is_empty() {
                txn.check(Safeguard::Unreviewed { reviewers: NEBTreeSet::new(you.clone()) });
            }
            metadata.endorsers.insert(you);
            Ok(())
        })
    }

    pub fn unendorse(&self, change_id: &ChangeIdRef) -> Result<()> {
        self.store.update_metadata(&BTreeSet::new(), change_id, |txn, metadata| {
            metadata.endorsers.remove(&txn.identity()?);
            Ok(())
        })
    }

    pub fn set_title(&self, change_id: &ChangeIdRef, title: Option<String>) -> Result<()> {
        self.store.update_metadata(&BTreeSet::new(), change_id, |_txn, metadata| {
            metadata.title = title;
            Ok(())
        })
    }

    /// Set `change_id`'s description; `None` or an empty text clears it.
    pub fn set_description(&self, change_id: &ChangeIdRef, description: Option<String>) -> Result<()> {
        let description = description.filter(|text| !text.is_empty());
        self.store.update_metadata(&BTreeSet::new(), change_id, |_txn, metadata| {
            metadata.description = description;
            Ok(())
        })
    }

    pub fn set_permanent(
        &self,
        change_id: &ChangeIdRef,
        permanent: bool,
        allow: &BTreeSet<SafeguardKind>,
    ) -> Result<()> {
        self.store.update_metadata(allow, change_id, |txn, metadata| {
            if metadata.permanent == permanent {
                return Ok(());
            }
            if metadata.archived {
                Err(format!("{change_id} is archived"))?;
            }
            txn.check_owner(change_id)?;
            if permanent {
                let mut impermanent = BTreeSet::new();
                for parent_id in &metadata.parents {
                    let parent = txn.metadata(parent_id)?;
                    // A root never lands, so is as permanent as a change gets.
                    if !parent.permanent && !parent.parents.is_empty() {
                        impermanent.insert(parent_id.clone());
                    }
                }
                if let Some(parents) = NEBTreeSet::try_from_set(impermanent) {
                    txn.check(Safeguard::ImpermanentParents { parents });
                }
            }
            metadata.permanent = permanent;
            Ok(())
        })
    }

    pub fn set_reviewing(
        &self,
        change_id: &ChangeIdRef,
        reviewing: Reviewing,
        allow: &BTreeSet<SafeguardKind>,
    ) -> Result<()> {
        self.store.update_metadata(allow, change_id, |txn, metadata| {
            if metadata.reviewing == reviewing {
                return Ok(());
            }
            txn.check_owner(change_id)?;
            metadata.reviewing = reviewing;
            Ok(())
        })
    }
}

impl Cabaret {
    /// The changes `viewer` owns that are still open, since owners are to push those forward;
    /// among them, those up for review with files `viewer` has left to review, since owners are to
    /// review every file of their changes (see `Branch::review_files`); and every change checked
    /// out in this device's workspaces, archived or not, since those are still active here; each
    /// with its ancestors as context.
    pub fn home(&self, viewer: &Identity) -> Result<Home> {
        self.store.query(|txn| {
            let trunk = txn.default_branch()?;
            let mut changes = BTreeMap::new();
            for id in txn.changes()? {
                changes.insert(id.clone(), txn.metadata(&id)?);
            }
            let owned: BTreeSet<ChangeId> = changes
                .iter()
                .filter(|(_, metadata)| !metadata.archived && metadata.owners.contains(viewer))
                .map(|(id, _)| id.clone())
                .collect();
            let mut to_review = BTreeSet::new();
            for id in &owned {
                let metadata = changes[id];
                if metadata.reviewing == Reviewing::None {
                    continue;
                }
                let review = metadata.review.get(viewer).cloned().unwrap_or_default();
                if !txn.branch(id)?.review_files(&metadata.parents, &review, &[])?.is_empty() {
                    to_review.insert(id.clone());
                }
            }
            let mut checked_out = BTreeSet::new();
            for workspace in txn.workspaces()? {
                let change = txn.workspace(workspace.to_ref())?.change();
                checked_out.extend(change.filter(|id| changes.contains_key(*id)).cloned());
            }
            Ok(Home {
                viewer: viewer.clone(),
                review: home_graph(&changes, &to_review, &trunk),
                owned: home_graph(&changes, &owned, &trunk),
                workspaces: home_graph(&changes, &checked_out, &trunk),
            })
        })
    }

    pub fn home_page(&self, viewer: &Identity) -> Result<Page> { Page::home(&self.home(viewer)?) }

    pub fn first_home_section(&self, viewer: &Identity) -> Result<HomeSection> {
        Ok(self.home(viewer)?.first_section())
    }
}

/// Record origin's default branch as `origin/HEAD` and check it out as a local branch, as a
/// non-bare clone does; a bare clone leaves `HEAD` naming a branch it never made.
fn track_origin_head(repo: &gix::Repository) -> Result<()> {
    use gix::refs::{
        Target,
        transaction::{Change, LogChange, PreviousValue, RefEdit},
    };
    let Some(head) = repo.head_name()? else { return Ok(()) };
    let tracking: gix::refs::FullName = format!("refs/remotes/origin/{}", head.shorten()).try_into()?;
    let Some(mut tip) = repo.try_find_reference(&tracking)? else { return Ok(()) };
    repo.reference(head, tip.peel_to_id()?.detach(), PreviousValue::MustNotExist, "clone: from origin")?;
    repo.edit_reference(RefEdit {
        change: Change::Update {
            log: LogChange::default(),
            expected: PreviousValue::MustNotExist,
            new: Target::Symbolic(tracking),
        },
        name: "refs/remotes/origin/HEAD".try_into()?,
        deref: false,
    })?;
    Ok(())
}

/// `None` for a change that cannot land: an archived one, or a root.
fn next_step<'txn>(txn: &'txn Transaction<'txn>, change_id: &ChangeIdRef) -> Result<Option<NextStep>> {
    let metadata = txn.metadata(change_id)?;
    if metadata.archived {
        return Ok(None);
    }
    let Some(parents) = NEBTreeSet::try_from_set(metadata.parents.clone()) else { return Ok(None) };

    // Fix broken states if present
    if metadata.fixed_parents()? != metadata.parents {
        return Ok(Some(NextStep::FixParents));
    }
    let branch = txn.branch(change_id)?;
    if let Some(files) = NEBTreeSet::try_from_set(branch.conflicted_files(parents.as_ref())?) {
        return Ok(Some(NextStep::ResolveConflicts { files }));
    }
    let mut stale = BTreeSet::new();
    for parent in &parents {
        if !txn.is_predecessor(txn.branch(parent)?.tip, branch.tip)? {
            stale.insert(parent.clone());
        }
    }
    let mut conflicted = BTreeSet::new();
    for parent in &stale {
        if !txn.branch(parent)?.conflicted_files(&txn.metadata(parent)?.parents)?.is_empty() {
            conflicted.insert(parent.clone());
        }
    }
    if let Some(parents) = NEBTreeSet::try_from_set(conflicted) {
        return Ok(Some(NextStep::ResolveParentConflicts { parents }));
    }
    if let Some(parents) = NEBTreeSet::try_from_set(stale) {
        return Ok(Some(NextStep::Rebase { parents }));
    }

    // Work towards landing
    if branch.changed_files(parents.as_ref(), &[])?.is_empty() {
        return Ok(Some(NextStep::AddCode));
    }
    let unreviewed = unreviewed(metadata, branch, parents.as_ref())?;
    if metadata.reviewing == Reviewing::None && !unreviewed.is_empty() {
        return Ok(Some(NextStep::RequestReview));
    }
    if let Some(reviewers) = NEBTreeSet::try_from_set(unreviewed) {
        return Ok(Some(NextStep::Review { reviewers }));
    }
    if let Some(owners) = NEBTreeSet::try_from_set(metadata.unendorsed()) {
        return Ok(Some(NextStep::Endorse { owners }));
    }
    Ok(Some(match parents.iter().collect::<Vec<_>>().as_slice() {
        [into] => NextStep::Land { into: (*into).clone() },
        _ => NextStep::LandParents { parents },
    }))
}

/// Owners with files left to review, since owners are to review every file of their changes.
fn unreviewed(
    metadata: &Metadata<'_>,
    branch: &Branch<'_>,
    parents: &BTreeSet<ChangeId>,
) -> Result<BTreeSet<Identity>> {
    let mut reviewers = BTreeSet::new();
    for owner in &metadata.owners {
        let review = metadata.review.get(owner).cloned().unwrap_or_default();
        if !branch.review_files(parents, &review, &[])?.is_empty() {
            reviewers.insert(owner.clone());
        }
    }
    Ok(reviewers)
}

/// The open changes landing into `change_id`.
fn open_children<'txn>(txn: &'txn Transaction<'txn>, change_id: &ChangeIdRef) -> Result<BTreeSet<ChangeId>> {
    let mut children = BTreeSet::new();
    for id in txn.changes()? {
        let metadata = txn.metadata(&id)?;
        if !metadata.archived && metadata.parents.contains(change_id) {
            children.insert(id);
        }
    }
    Ok(children)
}

/// The one parent `change_id` lands into.
fn landing_parent<'txn>(txn: &'txn Transaction<'txn>, change_id: &ChangeIdRef) -> Result<ChangeId> {
    match txn.metadata(change_id)?.parents.iter().collect::<Vec<_>>().as_slice() {
        [] => Err(format!("{change_id} cannot land while it has no parents"))?,
        [_, _, ..] => Err(format!("{change_id} cannot land while it has multiple parents"))?,
        [parent] => Ok((*parent).clone()),
    }
}

/// Whether `metadata`'s parents share no ancestor, so could never coalesce into one to land into.
fn no_common_ancestor(metadata: &Metadata<'_>) -> Result<Option<Safeguard>> {
    let Some(parents) = NEBTreeSet::try_from_set(metadata.parents.clone()) else { return Ok(None) };
    let mut common: Option<BTreeSet<ChangeId>> = None;
    for parent in &parents {
        let ancestors = metadata.txn().ancestors(parent)?;
        common = Some(match common {
            None => ancestors,
            Some(common) => &common & &ancestors,
        });
    }
    Ok(common.is_some_and(|common| common.is_empty()).then_some(Safeguard::NoCommonAncestor { parents }))
}

/// The parents rebasing onto `onto`, or onto every parent when `None`, merges in.
fn rebase_targets(metadata: &Metadata<'_>, onto: Option<&ChangeIdRef>) -> Result<BTreeSet<ChangeId>> {
    let change_id = metadata.id();
    let parents = &metadata.parents;
    Ok(match onto {
        None if parents.is_empty() => Err(format!("{change_id} has no parents to rebase onto"))?,
        None => parents.clone(),
        Some(onto) if parents.contains(onto) => BTreeSet::from([onto.to_owned()]),
        Some(onto) => Err(format!("{onto} is not a parent of {change_id}"))?,
    })
}

/// `selected` and their ancestors within `changes`; an archived change hangs off what it landed
/// into. Trunk is drawn only when selected: as mere context it would root every stack, saying
/// nothing.
fn home_graph(
    changes: &BTreeMap<ChangeId, &Metadata<'_>>,
    selected: &BTreeSet<ChangeId>,
    trunk: &ChangeId,
) -> HomeGraph {
    let drawn = |id: &ChangeId| changes.contains_key(id) && (id != trunk || selected.contains(id));
    let mut nodes = BTreeMap::new();
    let mut frontier: VecDeque<ChangeId> = selected.iter().cloned().collect();
    while let Some(id) = frontier.pop_front() {
        if nodes.contains_key(&id) {
            continue;
        }
        let metadata = changes[&id];
        let parents: BTreeSet<ChangeId> = metadata.parents.iter().filter(|id| drawn(id)).cloned().collect();
        frontier.extend(parents.iter().cloned());
        let node = HomeNode {
            title: metadata.title.clone(),
            selected: selected.contains(&id),
            archived: metadata.archived,
            parents,
        };
        nodes.insert(id, node);
    }
    HomeGraph { nodes }
}

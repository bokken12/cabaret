use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    path::Path,
};

use cabaret_config::{Hints, Prefix};
use cabaret_page::{DiffView, Home, HomeGraph, HomeNode, HomeSection, NextStep, Page, TabCounts};
use cabaret_transaction::{
    Branch, BranchOp, Metadata, Status, Store, TransactionContext, WorkspaceOp, pathspec_search,
};
use cabaret_types::{
    ChangeId, ChangeIdRef, ChangeSnapshot, ChangedFile, FileDiff, FileVersion, Identity, LineCounts, Pathspec,
    RepoPath, Result, Reviewing, RevisionId, ViewDiff,
    safeguard::{
        Allow, ArchivedParent, ArchivedParents, BaseMoves, Conflicted, Empty, ImpermanentParents, NoCommonAncestor,
        NonOwner, OpenChildren, Ownerless, ParentConflicted, ParentUnreviewed, Parentless, Permanent, RedundantParent,
        RemovesOthers, Safeguard, Uncommitted, Unendorsed, Unreviewed,
    },
};
use jiff::Zoned;
use nonempty_collections::{NEBTreeSet, NonEmptyIterator};

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

// TODO-someday(joel): split implementation into files by topic
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
                gix::prepare_clone_bare(url, dir.join(".bare"))?
                    .fetch_only(gix::progress::Discard, &gix::interrupt::IS_INTERRUPTED)?;
            }
            None => {
                gix::init_bare(dir.join(".bare"))?;
            }
        }
        fs::write(dir.join(".git"), GITFILE)?;
        Ok(())
    }

    // Change operations

    pub fn changes(&self) -> Result<Vec<ChangeId>> { self.store.query(|ctx| ctx.changes()) }

    /// The title of every change that has one.
    pub fn titles(&self) -> Result<BTreeMap<ChangeId, String>> {
        self.store.query(|ctx| {
            let mut titles = BTreeMap::new();
            for change in ctx.changes()? {
                if let Some(title) = &ctx.metadata(&change)?.title {
                    titles.insert(change, title.clone());
                }
            }
            Ok(titles)
        })
    }

    pub fn current_change(&self) -> Result<ChangeId> { self.store.query(|ctx| ctx.current_change()) }

    pub fn trunk(&self) -> Result<ChangeId> { self.store.query(|ctx| ctx.default_branch()) }

    pub fn resolve(&self, spec: &str) -> Result<RevisionId> { self.store.query(|ctx| ctx.resolve(spec)) }

    pub fn title(&self, change_id: &ChangeIdRef) -> Result<Option<String>> {
        self.store.query(|ctx| Ok(ctx.metadata(change_id)?.title.clone()))
    }

    pub fn snapshot(&self, change_id: &ChangeIdRef) -> Result<ChangeSnapshot> {
        self.store.query(|ctx| ctx.snapshot(change_id))
    }

    /// The open changes targeting `change_id`, the inverse of `ChangeSnapshot::parents`. Archived
    /// changes are left out: every landed change targets trunk forever.
    pub fn children(&self, change_id: &ChangeIdRef) -> Result<BTreeSet<ChangeId>> {
        self.store.query(|ctx| open_children(ctx, change_id))
    }

    pub fn blob(&self, revision: RevisionId, path: &RepoPath) -> Result<Option<FileVersion>> {
        self.store.query(|ctx| ctx.blob(revision, path))
    }

    pub fn base(&self, change_id: &ChangeIdRef) -> Result<RevisionId> {
        self.store.query(|ctx| ctx.branch(change_id)?.base(&ctx.metadata(change_id)?.parents()?))
    }

    pub fn changed_files(&self, change_id: &ChangeIdRef, pathspecs: &[Pathspec]) -> Result<Vec<ChangedFile>> {
        self.store.query(|ctx| ctx.branch(change_id)?.changed_files(&ctx.metadata(change_id)?.parents()?, pathspecs))
    }

    pub fn show_page(&self, change_id: &ChangeIdRef) -> Result<Page> {
        let hints = self.config::<Hints>()?.unwrap_or_default();
        self.store.query(|ctx| {
            let change = ctx.snapshot(change_id)?;
            let workspace = match &change.workspace {
                Some(workspace) => Some(ctx.workspace(workspace.to_ref())?.path()),
                None => None,
            };
            Ok(Page::show(change_id, &change, workspace, next_step(ctx, change_id)?.as_ref(), &ctx.identity()?, hints))
        })
    }

    /// The files of `change_id` this repository's identity has left to review, restricted to
    /// `pathspecs` (all when empty); see `Branch::review_files`.
    pub fn review_files(&self, change_id: &ChangeIdRef, pathspecs: &[Pathspec]) -> Result<Vec<ChangedFile>> {
        self.store.query(|ctx| {
            let metadata = ctx.metadata(change_id)?;
            let review = metadata.review.get(&ctx.identity()?).cloned().unwrap_or_default();
            ctx.branch(change_id)?.review_files(&metadata.parents()?, &review, pathspecs)
        })
    }

    /// The files the workspace holding `change_id` has on disk that differ from the change's tip,
    /// restricted to `pathspecs` (all when empty): what [`Self::commit`] would record.
    pub fn workspace_files(&self, change_id: &ChangeIdRef, pathspecs: &[Pathspec]) -> Result<Vec<ChangedFile>> {
        let workspace_id = self.workspace_of(change_id)?;
        self.store.query(|ctx| ctx.workspace(workspace_id.to_ref())?.changed_files(pathspecs))
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
        self.store.query(|ctx| {
            let (metadata, branch) = (ctx.metadata(change_id)?, ctx.branch(change_id)?);
            let parents = metadata.parents()?;
            let tip = branch.tip;
            let files = match view {
                DiffView::Diff => {
                    let base = branch.base(&parents)?;
                    branch
                        .changed_files(&parents, pathspecs)?
                        .into_iter()
                        .map(|file| FileDiff::new(file, base, tip))
                        .collect()
                }
                DiffView::Review => {
                    let review = metadata.review.get(&ctx.identity()?).cloned().unwrap_or_default();
                    let mut bases = BTreeMap::new();
                    let mut files = Vec::new();
                    for file in branch.review_files(&parents, &review, pathspecs)? {
                        let reviewed = review.get(file.path()).copied();
                        let base = match bases.get(&reviewed) {
                            Some(&base) => base,
                            None => *bases.entry(reviewed).or_insert(branch.review_base(&parents, reviewed)?),
                        };
                        files.push(FileDiff::new(file, base, tip));
                    }
                    files
                }
                DiffView::Workspace => {
                    let workspace = ctx.workspace(workspace_id.as_ref().expect("looked up above").to_ref())?;
                    // One read of the disk, so every file listed is in the saved commit.
                    let tree = workspace.saved_tree(pathspecs)?;
                    let saved = ctx.commit(tree, vec![tip], change_id.as_bstr())?;
                    workspace.saved_changes(tree)?.into_iter().map(|file| FileDiff::new(file, tip, saved)).collect()
                }
            };
            Ok(ViewDiff { tip, files })
        })
    }

    /// The tabs over `change_id`'s pages, with `view`'s showing (`None` for its show page).
    pub fn change_tabs_page(&self, change_id: &ChangeIdRef, view: Option<DiffView>) -> Result<Page> {
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
        self.config::<Prefix>()?.unwrap_or_default().apply(name, &Zoned::now())
    }

    /// Create a change named `name` on `parent_ids`, returning its id.
    pub fn create(&self, name: &str, parent_ids: &NEBTreeSet<ChangeId>, owner: &Identity) -> Result<ChangeId> {
        let change_id = self.claim(name)?;
        let (first, rest) = parent_ids.nonempty_iter().next();
        let tip = self.store.query(|ctx| Ok(ctx.branch(first)?.tip))?;
        let branches = [BranchOp::Insert { id: &change_id, tip }];
        self.store.transact(&[&change_id], &branches, &[], |ctx, [metadata], [branch], []| {
            for parent_id in rest {
                branch.merge(ctx.branch(parent_id)?, "create")?;
            }
            metadata.title = Some(name.to_owned());
            metadata.parents = parent_ids.iter().cloned().collect();
            metadata.owners = BTreeSet::from([owner.clone()]);
            Ok(())
        })?;
        Ok(change_id)
    }

    /// Create a change named `name` between `child_id` and its parents, returning its id.
    pub fn create_parent(&self, name: &str, child_id: &ChangeIdRef, owner: &Identity) -> Result<ChangeId> {
        let change_id = self.claim(name)?;
        // TODO(joel): currently non-atomic to build tip
        let parents = self.store.query(|ctx| Ok(ctx.metadata(child_id)?.parents.clone()))?;
        let mut to_merge = parents.iter();
        let first = to_merge.next().ok_or_else(|| format!("{child_id} has no base to create a parent from"))?;

        let tip = self.store.query(|ctx| Ok(ctx.branch(first)?.tip))?;
        let branches = [BranchOp::Insert { id: &change_id, tip }];
        self.store.transact(&[&change_id, child_id], &branches, &[], |ctx, [change, child], [branch], []| {
            for parent_id in to_merge {
                branch.merge(ctx.branch(parent_id)?, "create")?;
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
    pub fn commit(&self, change_id: &ChangeIdRef, pathspecs: &[Pathspec], allow: &Allow) -> Result<RevisionId> {
        let workspace_id = self.workspace_of(change_id)?;
        let branches = [BranchOp::Update(change_id)];
        let workspaces = [WorkspaceOp::Update { id: workspace_id.to_ref() }];
        self.store.transact(&[], &branches, &workspaces, |ctx, [], [branch], [workspace]| {
            if ctx.metadata(change_id)?.archived {
                Err(format!("{change_id} is archived"))?;
            }
            // The workspace was found before its lock was taken, so it may have switched since.
            if workspace.change().is_none_or(|held| **held != *change_id) {
                Err(format!("{change_id} is no longer checked out in workspace {workspace_id}"))?;
            }
            // The index is only staged once nothing refuses, so a refusal leaves the workspace be.
            let tree = workspace.saved_tree(pathspecs)?;
            if tree.0 == ctx.repo.find_commit(branch.tip)?.tree_id()?.detach() {
                Err(format!("{change_id} has nothing to commit"))?;
            }
            let mut committed = branch.clone();
            committed.tip = ctx.commit(tree, vec![branch.tip], change_id.as_bstr())?;
            let parents = ctx.metadata(change_id)?.parents()?;
            let before = branch.conflicted_files(&parents)?;
            let added = committed.conflicted_files(&parents)?.difference(&before).cloned().collect();
            let safeguards = Vec::from_iter(
                NEBTreeSet::try_from_set(added).map(|files| Safeguard::Conflicted(Conflicted { files })),
            );
            allow.check(safeguards)?;
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
        self.store.transact(&[], &branches, &workspaces, |_ctx, [], [_branch], [workspace]| {
            // The workspace was found before its lock was taken, so it may have switched since.
            if workspace.change().is_none_or(|held| **held != *change_id) {
                Err(format!("{change_id} is no longer checked out in workspace {workspace_id}"))?;
            }
            workspace.discard(pathspecs)
        })
    }

    /// The safeguards that would refuse landing `change_id` now, for a frontend to ask about first.
    pub fn land_safeguards(&self, change_id: &ChangeIdRef) -> Result<Vec<Safeguard>> {
        self.store.query(|ctx| {
            let parent_id = landing_parent(ctx, change_id)?;
            let child_branch = ctx.branch(change_id)?;
            // A trial merge, whose commit nothing will point to, is how landing's result is known.
            let merged = ctx.branch(&parent_id)?.clone().merge(child_branch, "land")?;
            land_safeguards(ctx.metadata(change_id)?, child_branch, &parent_id, merged.as_ref())
        })
    }

    /// Merge `change_id` into its one parent and archive it unless it is permanent, returning the
    /// parent. Conflicts landing in a root are errors, since a root is never searched for them:
    /// rebase and resolve them first. Safeguards not in `allow` refuse, checked last so that
    /// allowing them cannot run into an error.
    pub fn land(&self, change_id: &ChangeIdRef, allow: &Allow) -> Result<ChangeId> {
        let parent_id = self.store.query(|ctx| landing_parent(ctx, change_id))?;
        // The child's branch is declared so it cannot move between the merge and the archive.
        let branches = [BranchOp::Update(&parent_id), BranchOp::Update(change_id)];
        self.store.transact(&[change_id], &branches, &[], |ctx, [child], [parent, child_branch], []| {
            if child.archived {
                Err(format!("{change_id} is archived"))?;
            }
            let merged = parent.merge(child_branch, "land")?;
            let conflicted = merged.as_ref().is_some_and(|conflicts| !conflicts.is_empty())
                || !child_branch.conflicted_files(&child.parents()?)?.is_empty();
            if conflicted && ctx.metadata(&parent_id)?.parents()?.is_empty() {
                Err(format!("{change_id} would land conflicts in {parent_id}, a root; rebase and resolve first"))?;
            }
            allow.check(land_safeguards(child, child_branch, &parent_id, merged.as_ref())?)?;
            if !child.permanent {
                child.archived = true;
            }
            Ok(parent_id.clone())
        })
    }

    /// The safeguards that would refuse rebasing `change_id` now, for a frontend to ask about first.
    pub fn rebase_safeguards(&self, change_id: &ChangeIdRef, onto: Option<&ChangeIdRef>) -> Result<Vec<Safeguard>> {
        self.store.query(|ctx| {
            let metadata = ctx.metadata(change_id)?;
            rebase_safeguards(metadata, ctx.branch(change_id)?, &rebase_targets(metadata, onto)?)
        })
    }

    /// Bring `change_id` up to date with `onto`, or with every parent when `onto` is `None`.
    /// Cabaret never rewrites history, so each parent's tip is merged in; a conflicting merge is
    /// committed with markers and stops the rebase there, so those are resolved before the next.
    /// Safeguards not in `allow` refuse, before anything is merged.
    pub fn rebase(&self, change_id: &ChangeIdRef, onto: Option<&ChangeIdRef>, allow: &Allow) -> Result<Rebase> {
        self.store.transact(&[], &[BranchOp::Update(change_id)], &[], |ctx, [], [branch], []| {
            let metadata = ctx.metadata(change_id)?;
            let targets = rebase_targets(metadata, onto)?;
            allow.check(rebase_safeguards(metadata, branch, &targets)?)?;

            let mut rebase = Rebase { merged: BTreeSet::new(), conflicts: BTreeSet::new(), remaining: BTreeSet::new() };
            let mut targets = targets.into_iter();
            for parent_id in targets.by_ref() {
                if let Some(conflicts) = branch.merge(ctx.branch(&parent_id)?, "rebase")? {
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

    pub fn archive(&self, change_id: &ChangeIdRef, allow: &Allow) -> Result<()> {
        self.store.update_metadata(change_id, |ctx, metadata| {
            if metadata.archived {
                return Ok(());
            }
            let mut safeguards = Vec::new();
            if let Some(children) = NEBTreeSet::try_from_set(open_children(ctx, change_id)?) {
                safeguards.push(Safeguard::OpenChildren(OpenChildren { children }));
            }
            if metadata.permanent {
                safeguards.push(Safeguard::Permanent(Permanent));
            }
            allow.check(safeguards)?;
            metadata.archived = true;
            Ok(())
        })
    }

    pub fn unarchive(&self, change_id: &ChangeIdRef, allow: &Allow) -> Result<()> {
        self.store.update_metadata(change_id, |ctx, metadata| {
            if !metadata.archived {
                return Ok(());
            }
            let mut archived = BTreeSet::new();
            for parent in &metadata.parents {
                if ctx.metadata(parent)?.archived {
                    archived.insert(parent.clone());
                }
            }
            let safeguards = Vec::from_iter(
                NEBTreeSet::try_from_set(archived)
                    .map(|parents| Safeguard::ArchivedParents(ArchivedParents { parents })),
            );
            allow.check(safeguards)?;
            metadata.archived = false;
            Ok(())
        })
    }

    pub fn add_owner(&self, change_id: &ChangeIdRef, owner: &Identity) -> Result<()> {
        self.store.update_metadata(change_id, |_ctx, metadata| {
            metadata.owners.insert(owner.clone());
            Ok(())
        })
    }

    pub fn remove_owner(&self, change_id: &ChangeIdRef, owner: &Identity, allow: &Allow) -> Result<()> {
        self.store.update_metadata(change_id, |ctx, metadata| {
            let before = metadata.owners.clone();
            if !metadata.owners.remove(owner) {
                return Ok(());
            }
            allow.check(owners_safeguards(&ctx.identity()?, &before, &metadata.owners))?;
            Ok(())
        })
    }

    pub fn set_owners(&self, change_id: &ChangeIdRef, owners: &BTreeSet<Identity>, allow: &Allow) -> Result<()> {
        self.store.update_metadata(change_id, |ctx, metadata| {
            if metadata.owners == *owners {
                return Ok(());
            }
            allow.check(owners_safeguards(&ctx.identity()?, &metadata.owners, owners))?;
            metadata.owners.clone_from(owners);
            Ok(())
        })
    }

    /// Declare `parent_id` a parent of `change_id`. A parent descending from the change is an
    /// error, since the graph would cycle.
    pub fn add_parent(&self, change_id: &ChangeIdRef, parent_id: &ChangeIdRef, allow: &Allow) -> Result<()> {
        self.store.update_metadata(change_id, |ctx, metadata| {
            if !metadata.parents.insert(parent_id.to_owned()) {
                return Ok(());
            }
            if parent_id == change_id {
                Err(format!("{change_id} cannot be its own parent"))?;
            }
            if ctx.metadata(parent_id)?.is_descendant(change_id)? {
                Err(format!("{parent_id} descends from {change_id}, so it cannot be its parent"))?;
            }
            allow.check(add_parent_safeguards(metadata, parent_id)?)?;
            Ok(())
        })
    }

    pub fn remove_parent(&self, change_id: &ChangeIdRef, parent_id: &ChangeIdRef, allow: &Allow) -> Result<()> {
        self.store.update_metadata(change_id, |_ctx, metadata| {
            let before = metadata.clone();
            if !metadata.parents.remove(parent_id) {
                return Ok(());
            }
            allow.check(remove_parent_safeguards(&before, metadata, parent_id)?)?;
            Ok(())
        })
    }

    /// Declare the parents `change_id` targets, see `Metadata::parents`, as its parents.
    pub fn fix_parents(&self, change_id: &ChangeIdRef) -> Result<()> {
        self.store.update_metadata(change_id, |_ctx, metadata| {
            metadata.parents = metadata.parents()?;
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
        self.store.update_metadata(change_id, |ctx, metadata| {
            let branch = ctx.branch(change_id)?;
            let revision = head.unwrap_or(branch.tip);
            let parents = metadata.parents()?;
            let review = metadata.review.entry(ctx.identity()?).or_default();
            let left = branch.review_files(&parents, review, &[])?;
            let mut files = BTreeSet::new();
            let mut unmatched = Vec::new();
            for pathspec in pathspecs {
                let mut search = pathspec_search(&ctx.repo, std::slice::from_ref(pathspec))?;
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
    pub fn endorse(&self, change_id: &ChangeIdRef, allow: &Allow) -> Result<()> {
        self.store.update_metadata(change_id, |ctx, metadata| {
            let you = ctx.identity()?;
            let review = metadata.review.get(&you).cloned().unwrap_or_default();
            if !ctx.branch(change_id)?.review_files(&metadata.parents()?, &review, &[])?.is_empty() {
                allow.check(vec![Safeguard::Unreviewed(Unreviewed { reviewers: NEBTreeSet::new(you.clone()) })])?;
            }
            metadata.endorsers.insert(you);
            Ok(())
        })
    }

    pub fn unendorse(&self, change_id: &ChangeIdRef) -> Result<()> {
        self.store.update_metadata(change_id, |ctx, metadata| {
            metadata.endorsers.remove(&ctx.identity()?);
            Ok(())
        })
    }

    pub fn set_title(&self, change_id: &ChangeIdRef, title: Option<String>) -> Result<()> {
        self.store.update_metadata(change_id, |_ctx, metadata| {
            metadata.title = title;
            Ok(())
        })
    }

    /// Set `change_id`'s description; `None` or an empty text clears it.
    pub fn set_description(&self, change_id: &ChangeIdRef, description: Option<String>) -> Result<()> {
        let description = description.filter(|text| !text.is_empty());
        self.store.update_metadata(change_id, |_ctx, metadata| {
            metadata.description = description;
            Ok(())
        })
    }

    pub fn set_permanent(&self, change_id: &ChangeIdRef, permanent: bool, allow: &Allow) -> Result<()> {
        self.store.update_metadata(change_id, |ctx, metadata| {
            if metadata.permanent == permanent {
                return Ok(());
            }
            if metadata.archived {
                Err(format!("{change_id} is archived"))?;
            }
            let mut safeguards = Vec::from_iter(non_owner(metadata)?.map(Safeguard::NonOwner));
            if permanent {
                let mut impermanent = BTreeSet::new();
                for parent_id in metadata.parents()? {
                    let parent = ctx.metadata(&parent_id)?;
                    // A root never lands, so is as permanent as a change gets.
                    if !parent.permanent && !parent.parents()?.is_empty() {
                        impermanent.insert(parent_id);
                    }
                }
                if let Some(parents) = NEBTreeSet::try_from_set(impermanent) {
                    safeguards.push(Safeguard::ImpermanentParents(ImpermanentParents { parents }));
                }
            }
            allow.check(safeguards)?;
            metadata.permanent = permanent;
            Ok(())
        })
    }

    pub fn set_reviewing(&self, change_id: &ChangeIdRef, reviewing: Reviewing, allow: &Allow) -> Result<()> {
        self.store.update_metadata(change_id, |_ctx, metadata| {
            if metadata.reviewing == reviewing {
                return Ok(());
            }
            allow.check(Vec::from_iter(non_owner(metadata)?.map(Safeguard::NonOwner)))?;
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
        self.store.query(|ctx| {
            let trunk = ctx.default_branch()?;
            let mut changes = BTreeMap::new();
            for id in ctx.changes()? {
                changes.insert(id.clone(), ctx.metadata(&id)?);
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
                if !ctx.branch(id)?.review_files(&metadata.parents()?, &review, &[])?.is_empty() {
                    to_review.insert(id.clone());
                }
            }
            let mut checked_out = BTreeSet::new();
            for workspace in ctx.workspaces()? {
                let change = ctx.workspace(workspace.to_ref())?.change();
                checked_out.extend(change.filter(|id| changes.contains_key(*id)).cloned());
            }
            Ok(Home {
                viewer: viewer.clone(),
                review: home_graph(&changes, &to_review, &trunk)?,
                owned: home_graph(&changes, &owned, &trunk)?,
                workspaces: home_graph(&changes, &checked_out, &trunk)?,
            })
        })
    }

    pub fn home_page(&self, viewer: &Identity) -> Result<Page> { Page::home(&self.home(viewer)?) }

    pub fn home_section_page(&self, viewer: &Identity, section: HomeSection) -> Result<Page> {
        Page::home_section(&self.home(viewer)?, section)
    }

    pub fn first_home_section(&self, viewer: &Identity) -> Result<HomeSection> {
        Ok(self.home(viewer)?.first_section())
    }
}

/// `None` for a change that cannot land: an archived one, or a root.
fn next_step<'ctx>(ctx: &'ctx TransactionContext<'ctx>, change_id: &ChangeIdRef) -> Result<Option<NextStep>> {
    let metadata = ctx.metadata(change_id)?;
    if metadata.archived {
        return Ok(None);
    }
    let Some(parents) = NEBTreeSet::try_from_set(metadata.parents()?) else { return Ok(None) };

    // Fix broken states if present
    let branch = ctx.branch(change_id)?;
    if let Some(files) = NEBTreeSet::try_from_set(branch.conflicted_files(parents.as_ref())?) {
        return Ok(Some(NextStep::ResolveConflicts { files }));
    }
    let mut stale = BTreeSet::new();
    for parent in &parents {
        if !ctx.is_predecessor(ctx.branch(parent)?.tip, branch.tip)? {
            stale.insert(parent.clone());
        }
    }
    let mut conflicted = BTreeSet::new();
    for parent in &stale {
        if !ctx.branch(parent)?.conflicted_files(&ctx.metadata(parent)?.parents()?)?.is_empty() {
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
fn open_children<'ctx>(ctx: &'ctx TransactionContext<'ctx>, change_id: &ChangeIdRef) -> Result<BTreeSet<ChangeId>> {
    let mut children = BTreeSet::new();
    for id in ctx.changes()? {
        let metadata = ctx.metadata(&id)?;
        if !metadata.archived && metadata.parents()?.contains(change_id) {
            children.insert(id);
        }
    }
    Ok(children)
}

/// The one parent `change_id` lands into.
fn landing_parent<'ctx>(ctx: &'ctx TransactionContext<'ctx>, change_id: &ChangeIdRef) -> Result<ChangeId> {
    match ctx.metadata(change_id)?.parents()?.iter().collect::<Vec<_>>().as_slice() {
        [] => Err(format!("{change_id} cannot land while it has no parents"))?,
        [_, _, ..] => Err(format!("{change_id} cannot land while it has multiple parents"))?,
        [parent] => Ok((*parent).clone()),
    }
}

/// `merged` is what merging the change into `parent_id` gave: the files it conflicted in, or
/// `None` when the parent already held everything.
fn land_safeguards(
    metadata: &Metadata<'_>,
    branch: &Branch<'_>,
    parent_id: &ChangeIdRef,
    merged: Option<&BTreeSet<RepoPath>>,
) -> Result<Vec<Safeguard>> {
    let ctx = metadata.ctx();
    let parents = metadata.parents()?;
    let mut safeguards = Vec::from_iter(non_owner(metadata)?.map(Safeguard::NonOwner));
    if let Some(reviewers) = NEBTreeSet::try_from_set(unreviewed(metadata, branch, &parents)?) {
        safeguards.push(Safeguard::Unreviewed(Unreviewed { reviewers }));
    }
    if let Some(owners) = NEBTreeSet::try_from_set(metadata.unendorsed()) {
        safeguards.push(Safeguard::Unendorsed(Unendorsed { owners }));
    }
    let parent = ctx.metadata(parent_id)?;
    let grandparents = parent.parents()?;
    // A root has no diff of its own to review.
    if !grandparents.is_empty()
        && let Some(reviewers) = NEBTreeSet::try_from_set(unreviewed(parent, ctx.branch(parent_id)?, &grandparents)?)
    {
        safeguards.push(Safeguard::ParentUnreviewed(ParentUnreviewed { parent: parent_id.to_owned(), reviewers }));
    }
    match merged {
        None => safeguards.push(Safeguard::Empty(Empty { parent: parent_id.to_owned() })),
        Some(conflicts) => {
            let files = branch.conflicted_files(&parents)?.into_iter().chain(conflicts.iter().cloned()).collect();
            if let Some(files) = NEBTreeSet::try_from_set(files) {
                safeguards.push(Safeguard::Conflicted(Conflicted { files }));
            }
        }
    }
    if let Some(workspace) = branch.workspace()?
        && ctx.workspace(workspace.to_ref())?.status()? != Status::Clean
    {
        safeguards.push(Safeguard::Uncommitted(Uncommitted { workspace }));
    }
    Ok(safeguards)
}

/// What changing a change's owners from `before` to `after` risks, done by `you`.
fn owners_safeguards(you: &Identity, before: &BTreeSet<Identity>, after: &BTreeSet<Identity>) -> Vec<Safeguard> {
    let others: BTreeSet<Identity> = before.difference(after).filter(|owner| *owner != you).cloned().collect();
    let mut safeguards = Vec::from_iter(
        NEBTreeSet::try_from_set(others).map(|owners| Safeguard::RemovesOthers(RemovesOthers { owners })),
    );
    if after.is_empty() {
        safeguards.push(Safeguard::Ownerless(Ownerless));
    }
    safeguards
}

/// What declaring `added` a parent, as `metadata` now does, risks.
fn add_parent_safeguards(metadata: &Metadata<'_>, added: &ChangeIdRef) -> Result<Vec<Safeguard>> {
    let ctx = metadata.ctx();
    let mut safeguards = Vec::new();
    if ctx.metadata(added)?.archived && !metadata.archived {
        safeguards.push(Safeguard::ArchivedParent(ArchivedParent { parent: added.to_owned() }));
    }
    for other in metadata.parents.iter().filter(|other| other.as_ref() != added) {
        if ctx.metadata(other)?.is_descendant(added)? {
            let redundant = RedundantParent { parent: added.to_owned(), descendant: other.clone() };
            safeguards.push(Safeguard::RedundantParent(redundant));
            break;
        }
    }
    safeguards.extend(no_common_ancestor(metadata)?.map(Safeguard::NoCommonAncestor));
    Ok(safeguards)
}

/// What removing `removed` from `before`'s parents, as `after` has done, risks.
fn remove_parent_safeguards(
    before: &Metadata<'_>,
    after: &Metadata<'_>,
    removed: &ChangeIdRef,
) -> Result<Vec<Safeguard>> {
    let ctx = after.ctx();
    let mut safeguards = Vec::new();
    let (old, new) = (before.parents()?, after.parents()?);
    let branch = ctx.branch(after.id())?;
    if branch.base(&old)? != branch.base(&new)? {
        safeguards.push(Safeguard::BaseMoves(BaseMoves { removed: removed.to_owned() }));
    }
    if new.is_empty() {
        safeguards.push(Safeguard::Parentless(Parentless));
    }
    safeguards.extend(no_common_ancestor(after)?.map(Safeguard::NoCommonAncestor));
    Ok(safeguards)
}

/// Whether `metadata`'s parents share no ancestor, so could never coalesce into one to land into.
fn no_common_ancestor(metadata: &Metadata<'_>) -> Result<Option<NoCommonAncestor>> {
    let Some(parents) = NEBTreeSet::try_from_set(metadata.parents()?) else { return Ok(None) };
    let mut common: Option<BTreeSet<ChangeId>> = None;
    for parent in &parents {
        let ancestors = metadata.ctx().ancestors(parent)?;
        common = Some(match common {
            None => ancestors,
            Some(common) => &common & &ancestors,
        });
    }
    Ok(common.is_some_and(|common| common.is_empty()).then_some(NoCommonAncestor { parents }))
}

/// The parents rebasing onto `onto`, or onto every parent when `None`, merges in.
fn rebase_targets(metadata: &Metadata<'_>, onto: Option<&ChangeIdRef>) -> Result<BTreeSet<ChangeId>> {
    let change_id = metadata.id();
    let parents = metadata.parents()?;
    Ok(match onto {
        None if parents.is_empty() => Err(format!("{change_id} has no parents to rebase onto"))?,
        None => parents,
        Some(onto) if parents.contains(onto) => BTreeSet::from([onto.to_owned()]),
        Some(onto) => Err(format!("{onto} is not a parent of {change_id}"))?,
    })
}

fn rebase_safeguards(
    metadata: &Metadata<'_>,
    branch: &Branch<'_>,
    targets: &BTreeSet<ChangeId>,
) -> Result<Vec<Safeguard>> {
    let ctx = metadata.ctx();
    let mut safeguards = Vec::from_iter(non_owner(metadata)?.map(Safeguard::NonOwner));
    if let Some(files) = NEBTreeSet::try_from_set(branch.conflicted_files(&metadata.parents()?)?) {
        safeguards.push(Safeguard::Conflicted(Conflicted { files }));
    }
    for target in targets {
        let parent = ctx.branch(target)?;
        // A parent already merged in brings nothing, conflicts included.
        if ctx.is_predecessor(parent.tip, branch.tip)? {
            continue;
        }
        if let Some(files) = NEBTreeSet::try_from_set(parent.conflicted_files(&ctx.metadata(target)?.parents()?)?) {
            safeguards.push(Safeguard::ParentConflicted(ParentConflicted { parent: target.clone(), files }));
        }
    }
    Ok(safeguards)
}

fn non_owner(metadata: &Metadata<'_>) -> Result<Option<NonOwner>> {
    let you = metadata.ctx().identity()?;
    Ok((!metadata.owners.contains(&you)).then(|| NonOwner { you, owners: metadata.owners.clone() }))
}

/// `selected` and their ancestors within `changes`. Ancestry is the changes each targets, so an
/// open change hangs past an archived parent even when that parent is drawn; an archived change
/// hangs off what it landed into. Trunk is drawn only when selected: as mere context it would
/// root every stack, saying nothing.
fn home_graph(
    changes: &BTreeMap<ChangeId, &Metadata<'_>>,
    selected: &BTreeSet<ChangeId>,
    trunk: &ChangeId,
) -> Result<HomeGraph> {
    let drawn = |id: &ChangeId| changes.contains_key(id) && (id != trunk || selected.contains(id));
    let mut nodes = BTreeMap::new();
    let mut frontier: VecDeque<ChangeId> = selected.iter().cloned().collect();
    while let Some(id) = frontier.pop_front() {
        if nodes.contains_key(&id) {
            continue;
        }
        let metadata = changes[&id];
        let parents: BTreeSet<ChangeId> = metadata.parents()?.into_iter().filter(drawn).collect();
        frontier.extend(parents.iter().cloned());
        let node = HomeNode { title: metadata.title.clone(), selected: selected.contains(&id), parents };
        nodes.insert(id, node);
    }
    Ok(HomeGraph { nodes })
}

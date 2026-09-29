use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fmt, fs,
    path::{Path, PathBuf},
};

use cabaret_agents::{ClaudeCode, Session};
use cabaret_config::{Hints, Prefix, Scope, Setting};
use cabaret_transaction::{Branch, BranchOp, Head, Metadata, Status, Store, TransactionContext, WorkspaceOp};
use cabaret_types::{
    ChangeId, ChangeIdRef, ChangeSnapshot, ChangedFile, FileDiff, FileVersion, Identity, Pathspec, RepoPath, Result,
    RevisionId, TimestampMs, ViewDiff, WorkspaceId, WorkspaceIdRef,
    safeguard::{
        AddParentAllow, AddParentSafeguard, ArchivedParent, BaseMoves, Conflicted, Empty, LandAllow, LandSafeguard,
        NoCommonAncestor, NonOwner, Ownerless, OwnersAllow, OwnersSafeguard, ParentConflicted, ParentUnreviewed,
        Parentless, RebaseAllow, RebaseSafeguard, RedundantParent, RemoveParentAllow, RemoveParentSafeguard,
        RemovesOthers, Uncommitted, Unreviewed,
    },
};
use gix::bstr::ByteSlice;
use jiff::Zoned;
use nonempty_collections::{NEBTreeSet, NEVec, NonEmptyIterator};

use crate::{
    home::{Home, HomeGraph, HomeNode, HomeSection},
    page::{DiffView, Page, TabCounts},
};

/// Marks a project directory, one holding the bare repository `.bare` beside one workspace per
/// change, as the repository's own: git commands work from it and nothing else shares it.
const GITFILE: &str = "gitdir: ./.bare\n";

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

/// The first thing standing between a change and landing, in the order they must be resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NextStep {
    /// Its tip adds nothing to its base, so there is nothing to land.
    AddCode,
    /// Files its tip holds conflict markers in; they are resolved before anything more is merged.
    ResolveConflicts {
        files: BTreeSet<RepoPath>,
    },
    /// Parents it lags behind that hold conflict markers of their own, which a rebase would take on.
    ResolveParentConflicts {
        parents: BTreeSet<ChangeId>,
    },
    /// Parents whose tips its bases lag behind.
    Rebase {
        parents: BTreeSet<ChangeId>,
    },
    /// Owners with files left to review, since owners are to review every file of their changes.
    Review {
        reviewers: BTreeSet<Identity>,
    },
    /// A change lands into one parent, so several must first coalesce by landing.
    LandParents {
        parents: BTreeSet<ChangeId>,
    },
    Land {
        into: ChangeId,
    },
}

/// What [`Cabaret::workspace_prune`] did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Prune {
    pub removed: BTreeSet<WorkspaceId>,
    /// Workspaces of archived changes left standing, each with why it could not go.
    pub kept: BTreeMap<WorkspaceId, String>,
}

/// Cabaret provides the external-facing interface, with actions at the level a porcelain performs.
pub struct Cabaret {
    store: Store,
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

    // Config operations

    /// `S` as git config reads it here, from whichever scope sets it.
    pub fn config<S: Setting>(&self) -> Result<Option<S>> { cabaret_config::get(&self.store.repo.to_thread_local()) }

    pub fn set_config<S: Setting>(&mut self, scope: Scope, value: &S) -> Result<()> {
        cabaret_config::set(&self.store.repo.to_thread_local(), scope, value)?;
        self.reload()
    }

    pub fn unset_config<S: Setting>(&mut self, scope: Scope) -> Result<()> {
        cabaret_config::unset::<S>(&self.store.repo.to_thread_local(), scope)?;
        self.reload()
    }

    /// Reread the repository, so config written since it was opened is seen.
    fn reload(&mut self) -> Result<()> {
        let mut repo = self.store.repo.to_thread_local();
        repo.reload()?;
        self.store.repo = repo.into_sync();
        Ok(())
    }

    // Workspace operations

    /// Every workspace and the change checked out in it, `None` where HEAD is detached.
    pub fn workspaces(&self) -> Result<BTreeMap<WorkspaceId, Option<ChangeId>>> {
        self.store.query(|ctx| {
            let mut workspaces = BTreeMap::new();
            for workspace in ctx.workspaces()? {
                let change = ctx.workspace(workspace.to_ref())?.change().cloned();
                workspaces.insert(workspace, change);
            }
            Ok(workspaces)
        })
    }

    pub fn workspace_holding(&self, change_id: &ChangeIdRef) -> Result<Option<WorkspaceId>> {
        self.store.query(|ctx| ctx.branch(change_id)?.workspace())
    }

    /// The workspace holding `change_id`, which the operations on a change's files need.
    pub fn workspace_of(&self, change_id: &ChangeIdRef) -> Result<WorkspaceId> {
        self.workspace_holding(change_id)?
            .ok_or_else(|| format!("{change_id} is not checked out in any workspace").into())
    }

    /// The workspace whose working directory is `path`.
    pub fn workspace_at(&self, path: &Path) -> Result<WorkspaceId> {
        let path = fs::canonicalize(path)?;
        self.store.query(|ctx| {
            for workspace in ctx.workspaces()? {
                if fs::canonicalize(ctx.workspace(workspace.to_ref())?.path()).ok().as_deref() == Some(&path) {
                    return Ok(workspace);
                }
            }
            Err(format!("no workspace at {}", path.display()).into())
        })
    }

    /// The workspace this instance was opened in.
    pub fn workspace_current(&self) -> Result<WorkspaceId> { self.store.query(|ctx| ctx.current_workspace()) }

    pub fn workspace_path(&self, workspace_id: WorkspaceIdRef<'_>) -> Result<PathBuf> {
        self.store.query(|ctx| Ok(ctx.workspace(workspace_id)?.path().to_owned()))
    }

    /// Create a workspace holding `change_id` at `path`, or the default location, and return
    /// where it was made. Declaring the branch keeps it still while the files are written.
    pub fn workspace_add(&self, change_id: ChangeId, path: Option<PathBuf>) -> Result<PathBuf> {
        let path = match path {
            Some(path) => std::path::absolute(path)?,
            None => self.default_workspace_path(&change_id)?,
        };
        self.store.transact(
            &[],
            &[BranchOp::Update(&change_id)],
            &[WorkspaceOp::Insert { path: &path, head: Head::Change(change_id.clone()) }],
            |_ctx, [], [_branch], [_workspace]| Ok(()),
        )?;
        Ok(path)
    }

    /// Beside the main workspace as `<name>-<change>`, so checkouts of several repositories can
    /// share a parent directory. A bare repository has no main workspace; its workspaces go
    /// beside its git dir as `<change>`, in the project directory a `.git` file marks as its own.
    fn default_workspace_path(&self, change_id: &ChangeIdRef) -> Result<PathBuf> {
        let main = self.store.repo.to_thread_local().main_repo()?;
        // `~` for the slashes a directory name cannot hold; git forbids it in branch names, so no
        // two changes share a directory
        let change = gix::path::from_bstring(change_id.as_bstr().replace("/", "~"));
        let Some(workdir) = main.workdir() else {
            // Canonical, as a linked workspace reaches its common dir through `..` segments.
            let git_dir = fs::canonicalize(main.git_dir())?;
            let project = git_dir.parent().ok_or("bare repository has no parent directory")?;
            let marked = gix::open(project).ok().and_then(|repo| fs::canonicalize(repo.git_dir()).ok());
            if marked.as_deref() != Some(&*git_dir) {
                Err(format!(
                    "no .git file marks {} as the bare repository's own directory; pass a path, or lay the \
                     repository out as <dir>/.bare with a .git file pointing at it",
                    project.display()
                ))?;
            }
            return Ok(project.join(change));
        };
        let mut name = workdir.file_name().ok_or("main workspace has no directory name")?.to_os_string();
        name.push("-");
        name.push(change.as_os_str());
        Ok(workdir.parent().ok_or("main workspace has no parent directory")?.join(name))
    }

    /// Removing a workspace needs the branch it holds, which is only known once read; the
    /// transaction re-checks it under the lock.
    pub fn workspace_remove(&self, workspace_id: WorkspaceIdRef<'_>) -> Result<()> {
        let delete = [WorkspaceOp::Delete { id: workspace_id }];
        match self.store.query(|ctx| Ok(ctx.workspace(workspace_id)?.change().cloned()))? {
            Some(held) => self.store.transact(
                &[],
                &[BranchOp::Update(&held)],
                &delete,
                |_ctx, [], [_branch], [_workspace]| Ok(()),
            ),
            None => self.store.transact(&[], &[], &delete, |_ctx, [], [], [_workspace]| Ok(())),
        }
    }

    /// Remove every workspace holding an archived change. Each goes in its own transaction, which
    /// re-checks the change under its lock, so one that cannot go leaves the rest to be pruned.
    pub fn workspace_prune(&self) -> Result<Prune> {
        let archived = self.store.query(|ctx| {
            let mut archived = Vec::new();
            for workspace in ctx.workspaces()? {
                if let Some(change) = ctx.workspace(workspace.to_ref())?.change()
                    && ctx.metadata(change)?.archived
                {
                    archived.push((workspace, change.clone()));
                }
            }
            Ok(archived)
        })?;
        let mut prune = Prune::default();
        for (workspace, change) in archived {
            let removed = self.store.transact(
                &[&change],
                &[BranchOp::Update(&change)],
                &[WorkspaceOp::Delete { id: workspace.to_ref() }],
                |_ctx, [metadata], [_branch], [_workspace]| match metadata.archived {
                    true => Ok(()),
                    false => Err(format!("{change} is no longer archived").into()),
                },
            );
            match removed {
                Ok(()) => {
                    prune.removed.insert(workspace);
                }
                Err(error) => {
                    prune.kept.insert(workspace, format!("{error:?}"));
                }
            }
        }
        Ok(prune)
    }

    pub fn workspace_switch(&self, workspace_id: WorkspaceIdRef<'_>, change_id: ChangeId) -> Result<()> {
        self.store.transact(
            &[],
            &[BranchOp::Update(&change_id)],
            &[WorkspaceOp::Update { id: workspace_id }],
            |_ctx, [], [_branch], [workspace]| {
                workspace.head = Head::Change(change_id.clone());
                Ok(())
            },
        )
    }

    /// Whether a workspace sits at the default location for the change it holds, which names it
    /// as that change's own rather than one to switch between changes.
    pub fn workspace_is_dedicated(&self, workspace_id: WorkspaceIdRef<'_>) -> Result<bool> {
        let (path, held) = self.store.query(|ctx| {
            let workspace = ctx.workspace(workspace_id)?;
            Ok((workspace.path().to_owned(), workspace.change().cloned()))
        })?;
        let Some(held) = held else { return Ok(false) };
        let path = fs::canonicalize(path)?;
        // A default location that does not exist cannot be where the workspace is.
        Ok(fs::canonicalize(self.default_workspace_path(&held)?).is_ok_and(|default| default == path))
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

    pub fn identity(&self) -> Result<Identity> { self.store.query(|ctx| ctx.identity()) }

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
        self.store.query(|ctx| {
            let mut children = BTreeSet::new();
            for id in ctx.changes()? {
                let metadata = ctx.metadata(&id)?;
                if !metadata.archived && metadata.parents()?.contains(change_id) {
                    children.insert(id);
                }
            }
            Ok(children)
        })
    }

    pub fn blob(&self, revision: RevisionId, path: &RepoPath) -> Result<Option<FileVersion>> {
        self.store.query(|ctx| ctx.blob(revision, path))
    }

    pub fn base(&self, change_id: &ChangeIdRef) -> Result<Option<RevisionId>> {
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
        let files = self.view_files(change_id, view, pathspecs)?;
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
                    let saved = ctx.commit(workspace.saved_tree()?, vec![tip], change_id.as_bstr())?;
                    workspace
                        .changed_files(pathspecs)?
                        .into_iter()
                        .map(|file| FileDiff::new(file, Some(tip), saved))
                        .collect()
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

    /// The Claude Code sessions launched in the workspace holding `change_id`, or, when it is
    /// checked out nowhere, in its default workspace location: sessions outlive the workspace
    /// they worked in.
    pub fn sessions(&self, change_id: &ChangeIdRef, claude: &ClaudeCode) -> Result<Vec<Session>> {
        let dir = match self.workspace_holding(change_id)? {
            Some(workspace) => self.workspace_path(workspace.to_ref())?,
            None => self.default_workspace_path(change_id)?,
        };
        claude.sessions_in(&dir)
    }

    /// Start a Claude Code session on `prompt` in the workspace holding `change_id`.
    pub fn start_session(
        &self,
        change_id: &ChangeIdRef,
        prompt: &str,
        args: &[String],
        claude: &ClaudeCode,
    ) -> Result<()> {
        claude.start(&self.workspace_path(self.workspace_of(change_id)?.to_ref())?, prompt, args)
    }

    pub fn sessions_page(&self, change_id: &ChangeIdRef, claude: &ClaudeCode) -> Result<Page> {
        Ok(Page::sessions(change_id, &self.sessions(change_id, claude)?, TimestampMs::now()))
    }

    /// The id a change named `name` is created under: `name` behind the configured prefix.
    fn claim(&self, name: &str) -> Result<ChangeId> {
        self.config::<Prefix>()?.unwrap_or_default().apply(name, &Zoned::now())
    }

    /// Create a change named `name` on `parent_ids`, returning its id.
    pub fn create(&self, name: &str, parent_ids: NEBTreeSet<ChangeId>, owner: &Identity) -> Result<ChangeId> {
        let change_id = self.claim(name)?;
        let (first, rest) = parent_ids.nonempty_iter().next();
        let tip = self.store.query(|ctx| Ok(ctx.branch(first)?.tip))?;
        let branches = [BranchOp::Insert { id: &change_id, tip }];
        self.store.transact(&[&change_id], &branches, &[], |ctx, [metadata], [branch], []| {
            for parent_id in rest {
                branch.merge(ctx.branch(parent_id)?, "create")?;
            }
            metadata.title = Some(name.to_owned());
            metadata.declared_parents = parent_ids.iter().cloned().collect();
            metadata.owners = BTreeSet::from([owner.clone()]);
            Ok(())
        })?;
        Ok(change_id)
    }

    /// Create a change named `name` between `child_id` and its parents, returning its id.
    pub fn create_parent(&self, name: &str, child_id: &ChangeIdRef, owner: &Identity) -> Result<ChangeId> {
        let change_id = self.claim(name)?;
        // TODO(joel): currently non-atomic to build tip
        let parents = self.store.query(|ctx| Ok(ctx.metadata(child_id)?.declared_parents.clone()))?;
        let mut to_merge = parents.iter();
        let first = to_merge.next().ok_or_else(|| format!("{child_id} has no base to create a parent from"))?;

        let tip = self.store.query(|ctx| Ok(ctx.branch(first)?.tip))?;
        let branches = [BranchOp::Insert { id: &change_id, tip }];
        self.store.transact(&[&change_id, child_id], &branches, &[], |ctx, [change, child], [branch], []| {
            for parent_id in to_merge {
                branch.merge(ctx.branch(parent_id)?, "create")?;
            }
            change.title = Some(name.to_owned());
            change.declared_parents = parents.clone();
            change.owners = BTreeSet::from([owner.clone()]);
            child.declared_parents = BTreeSet::from([change_id.clone()]);
            Ok(())
        })?;
        Ok(change_id)
    }

    /// Record what the workspace holding `change_id` has on disk at the paths `pathspecs` match,
    /// all when empty, as a new commit on the change, returning it. The commit is named for the
    /// change and nothing more: commits are for the computer, not for reading.
    pub fn commit(&self, change_id: &ChangeIdRef, pathspecs: &[Pathspec]) -> Result<RevisionId> {
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
            let tree = workspace.snapshot(pathspecs)?;
            if tree.0 == ctx.repo.find_commit(branch.tip)?.tree_id()?.detach() {
                Err(format!("{change_id} has nothing to commit"))?;
            }
            branch.tip = ctx.commit(tree, vec![branch.tip], change_id.as_bstr())?;
            Ok(branch.tip)
        })
    }

    /// Drop what `change_id`'s workspace has on disk at the paths `pathspecs` match, all when
    /// empty, putting them back as the change's tip has them.
    pub fn discard(&self, change_id: &ChangeIdRef, pathspecs: &[Pathspec]) -> Result<()> {
        let workspace_id = self.workspace_of(change_id)?;
        let workspaces = [WorkspaceOp::Update { id: workspace_id.to_ref() }];
        self.store.transact(&[], &[], &workspaces, |_ctx, [], [], [workspace]| {
            // The workspace was found before its lock was taken, so it may have switched since.
            if workspace.change().is_none_or(|held| **held != *change_id) {
                Err(format!("{change_id} is no longer checked out in workspace {workspace_id}"))?;
            }
            workspace.discard(pathspecs)
        })
    }

    /// The safeguards that would refuse landing `change_id` now, for a frontend to ask about first.
    pub fn land_safeguards(&self, change_id: &ChangeIdRef) -> Result<Vec<LandSafeguard>> {
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
    pub fn land(
        &self,
        change_id: &ChangeIdRef,
        allow: LandAllow,
    ) -> Result<std::result::Result<ChangeId, NEVec<LandSafeguard>>> {
        let parent_id = self.store.query(|ctx| landing_parent(ctx, change_id))?;
        // The child's branch is declared so it cannot move between the merge and the archive.
        let branches = [BranchOp::Update(&parent_id), BranchOp::Update(change_id)];
        self.store.transact_or_abort(&[change_id], &branches, &[], |ctx, [child], [parent, child_branch], []| {
            if child.archived {
                Err(format!("{change_id} is archived"))?;
            }
            let merged = parent.merge(child_branch, "land")?;
            let conflicted = merged.as_ref().is_some_and(|conflicts| !conflicts.is_empty())
                || !child_branch.conflicted_files(&child.parents()?)?.is_empty();
            if conflicted && ctx.metadata(&parent_id)?.parents()?.is_empty() {
                Err(format!("{change_id} would land conflicts in {parent_id}, a root; rebase and resolve first"))?;
            }
            if let Some(refused) = allow.refused(land_safeguards(child, child_branch, &parent_id, merged.as_ref())?) {
                return Ok(Err(refused));
            }
            if !child.permanent {
                child.archived = true;
            }
            Ok(Ok(parent_id.clone()))
        })
    }

    /// The safeguards that would refuse rebasing `change_id` now, for a frontend to ask about first.
    pub fn rebase_safeguards(
        &self,
        change_id: &ChangeIdRef,
        onto: Option<&ChangeIdRef>,
    ) -> Result<Vec<RebaseSafeguard>> {
        self.store.query(|ctx| {
            let metadata = ctx.metadata(change_id)?;
            rebase_safeguards(metadata, ctx.branch(change_id)?, &rebase_targets(metadata, onto)?)
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
        allow: RebaseAllow,
    ) -> Result<std::result::Result<Rebase, NEVec<RebaseSafeguard>>> {
        self.store.transact_or_abort(&[], &[BranchOp::Update(change_id)], &[], |ctx, [], [branch], []| {
            let metadata = ctx.metadata(change_id)?;
            let targets = rebase_targets(metadata, onto)?;
            if let Some(refused) = allow.refused(rebase_safeguards(metadata, branch, &targets)?) {
                return Ok(Err(refused));
            }

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
            Ok(Ok(rebase))
        })
    }

    pub fn archive(&self, change_id: &ChangeIdRef) -> Result<()> {
        self.store.update_metadata(change_id, |_ctx, metadata| {
            // TODO(joel): warn if children unarchived?
            match metadata.archived {
                true => Err(format!("{change_id} has already been archived"))?,
                false => metadata.archived = true,
            };
            Ok(())
        })
    }

    pub fn unarchive(&self, change_id: &ChangeIdRef) -> Result<()> {
        self.store.update_metadata(change_id, |_ctx, metadata| {
            // TODO(joel): warn if parents archived?
            match metadata.archived {
                false => Err(format!("{change_id} has not been archived"))?,
                true => metadata.archived = false,
            };
            Ok(())
        })
    }

    /// Archive `change_id`, or unarchive it if it already is, returning whether it is now archived.
    pub fn toggle_archived(&self, change_id: &ChangeIdRef) -> Result<bool> {
        self.store.update_metadata(change_id, |_ctx, metadata| {
            metadata.archived = !metadata.archived;
            Ok(metadata.archived)
        })
    }

    pub fn add_owner(&self, change_id: &ChangeIdRef, owner: &Identity) -> Result<()> {
        self.store.update_metadata(change_id, |_ctx, metadata| match metadata.owners.insert(owner.clone()) {
            false => Err(format!("{owner} already owned {change_id}"))?,
            true => Ok(()),
        })
    }

    pub fn remove_owner(
        &self,
        change_id: &ChangeIdRef,
        owner: &Identity,
        allow: OwnersAllow,
    ) -> Result<std::result::Result<(), NEVec<OwnersSafeguard>>> {
        self.store.transact_or_abort(&[change_id], &[], &[], |ctx, [metadata], [], []| {
            let before = metadata.owners.clone();
            if !metadata.owners.remove(owner) {
                Err(format!("{owner} did not own {change_id}"))?;
            }
            if let Some(refused) = allow.refused(owners_safeguards(&ctx.identity()?, &before, &metadata.owners)) {
                return Ok(Err(refused));
            }
            Ok(Ok(()))
        })
    }

    pub fn set_owners(
        &self,
        change_id: &ChangeIdRef,
        owners: BTreeSet<Identity>,
        allow: OwnersAllow,
    ) -> Result<std::result::Result<(), NEVec<OwnersSafeguard>>> {
        self.store.transact_or_abort(&[change_id], &[], &[], |ctx, [metadata], [], []| {
            if metadata.owners == owners {
                Err(format!("{change_id} already had these owners"))?;
            }
            if let Some(refused) = allow.refused(owners_safeguards(&ctx.identity()?, &metadata.owners, &owners)) {
                return Ok(Err(refused));
            }
            metadata.owners = owners.clone();
            Ok(Ok(()))
        })
    }

    // TODO(joel): some helper that aligns the parent set with the derived parent set?

    /// Declare `parent_id` a parent of `change_id`. A parent descending from the change is an
    /// error, since the graph would cycle.
    pub fn add_parent(
        &self,
        change_id: &ChangeIdRef,
        parent_id: &ChangeIdRef,
        allow: AddParentAllow,
    ) -> Result<std::result::Result<(), NEVec<AddParentSafeguard>>> {
        self.store.transact_or_abort(&[change_id], &[], &[], |ctx, [metadata], [], []| {
            if !metadata.declared_parents.insert(parent_id.to_owned()) {
                Err(format!("{parent_id} was already a parent of {change_id}"))?;
            }
            if parent_id == change_id {
                Err(format!("{change_id} cannot be its own parent"))?;
            }
            if ctx.metadata(parent_id)?.is_descendant(change_id)? {
                Err(format!("{parent_id} descends from {change_id}, so it cannot be its parent"))?;
            }
            if let Some(refused) = allow.refused(add_parent_safeguards(metadata, parent_id)?) {
                return Ok(Err(refused));
            }
            Ok(Ok(()))
        })
    }

    pub fn remove_parent(
        &self,
        change_id: &ChangeIdRef,
        parent_id: &ChangeIdRef,
        allow: RemoveParentAllow,
    ) -> Result<std::result::Result<(), NEVec<RemoveParentSafeguard>>> {
        self.store.transact_or_abort(&[change_id], &[], &[], |_ctx, [metadata], [], []| {
            let before = metadata.clone();
            if !metadata.declared_parents.remove(parent_id) {
                Err(format!("{parent_id} was not a parent of {change_id}"))?;
            }
            if let Some(refused) = allow.refused(remove_parent_safeguards(&before, metadata, parent_id)?) {
                return Ok(Err(refused));
            }
            Ok(Ok(()))
        })
    }

    /// Record that this repository's identity has reviewed `files` of `change_id` from `bases` up
    /// to `head`; each defaults to the change's own.
    pub fn mark(&self, change_id: &ChangeIdRef, files: &[RepoPath], head: Option<RevisionId>) -> Result<()> {
        self.store.update_metadata(change_id, |ctx, metadata| {
            let branch = ctx.branch(change_id)?;
            let revision = head.unwrap_or(branch.tip);
            let review = metadata.review.entry(ctx.identity()?).or_default();
            if files.iter().all(|file| review.get(file) == Some(&revision)) {
                Err(format!("{change_id} already had these files marked reviewed there"))?;
            }
            review.extend(files.iter().map(|file| (file.clone(), revision.clone())));
            Ok(())
        })
    }

    pub fn set_title(&self, change_id: &ChangeIdRef, title: Option<String>) -> Result<()> {
        self.store.update_metadata(change_id, |_ctx, metadata| match metadata.title == title {
            true => Err(format!("{change_id} already had this title"))?,
            false => Ok(metadata.title = title),
        })
    }

    /// Set `change_id`'s description; `None` or an empty text clears it.
    pub fn set_description(&self, change_id: &ChangeIdRef, description: Option<String>) -> Result<()> {
        let description = description.filter(|text| !text.is_empty());
        self.store.update_metadata(change_id, |_ctx, metadata| match metadata.description == description {
            true => Err(format!("{change_id} already had this description"))?,
            false => Ok(metadata.description = description),
        })
    }

    pub fn set_permanent(&self, change_id: &ChangeIdRef, permanent: bool) -> Result<()> {
        self.store.update_metadata(change_id, |_ctx, metadata| {
            // TODO(joel): warn if parents non-permanent?
            match metadata.archived {
                true => Err(format!("{change_id} is archived"))?,
                _ => metadata.permanent = permanent,
            };
            Ok(())
        })
    }
}

impl Cabaret {
    /// The changes `viewer` owns that are still open, since owners are to push those forward;
    /// among them, those with files `viewer` has left to review, since owners are to review every
    /// file of their changes (see `Branch::review_files`); and every change checked out in this
    /// device's workspaces, archived or not, since those are still active here; each with its
    /// ancestors as context.
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
    let parents = metadata.parents()?;
    if metadata.archived || parents.is_empty() {
        return Ok(None);
    }
    let branch = ctx.branch(change_id)?;
    if branch.changed_files(&parents, &[])?.is_empty() {
        return Ok(Some(NextStep::AddCode));
    }
    let files = branch.conflicted_files(&parents)?;
    if !files.is_empty() {
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
    if !conflicted.is_empty() {
        return Ok(Some(NextStep::ResolveParentConflicts { parents: conflicted }));
    }
    if !stale.is_empty() {
        return Ok(Some(NextStep::Rebase { parents: stale }));
    }
    let reviewers = unreviewed(metadata, branch, &parents)?;
    if !reviewers.is_empty() {
        return Ok(Some(NextStep::Review { reviewers }));
    }
    Ok(Some(match parents.iter().collect::<Vec<_>>().as_slice() {
        [into] => NextStep::Land { into: (*into).clone() },
        _ => NextStep::LandParents { parents: parents.clone() },
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
) -> Result<Vec<LandSafeguard>> {
    let ctx = metadata.ctx();
    let parents = metadata.parents()?;
    let mut safeguards = Vec::from_iter(non_owner(metadata)?.map(LandSafeguard::NonOwner));
    if let Some(reviewers) = NEBTreeSet::try_from_set(unreviewed(metadata, branch, &parents)?) {
        safeguards.push(LandSafeguard::Unreviewed(Unreviewed { reviewers }));
    }
    let parent = ctx.metadata(parent_id)?;
    let grandparents = parent.parents()?;
    // A root has no diff of its own to review.
    if !grandparents.is_empty()
        && let Some(reviewers) = NEBTreeSet::try_from_set(unreviewed(parent, ctx.branch(parent_id)?, &grandparents)?)
    {
        safeguards.push(LandSafeguard::ParentUnreviewed(ParentUnreviewed { parent: parent_id.to_owned(), reviewers }));
    }
    match merged {
        None => safeguards.push(LandSafeguard::Empty(Empty { parent: parent_id.to_owned() })),
        Some(conflicts) => {
            let files = branch.conflicted_files(&parents)?.into_iter().chain(conflicts.iter().cloned()).collect();
            if let Some(files) = NEBTreeSet::try_from_set(files) {
                safeguards.push(LandSafeguard::Conflicted(Conflicted { files }));
            }
        }
    }
    if let Some(workspace) = branch.workspace()?
        && ctx.workspace(workspace.to_ref())?.status()? != Status::Clean
    {
        safeguards.push(LandSafeguard::Uncommitted(Uncommitted { workspace }));
    }
    Ok(safeguards)
}

/// What changing a change's owners from `before` to `after` risks, done by `you`.
fn owners_safeguards(you: &Identity, before: &BTreeSet<Identity>, after: &BTreeSet<Identity>) -> Vec<OwnersSafeguard> {
    let others: BTreeSet<Identity> = before.difference(after).filter(|owner| *owner != you).cloned().collect();
    let mut safeguards = Vec::from_iter(
        NEBTreeSet::try_from_set(others).map(|owners| OwnersSafeguard::RemovesOthers(RemovesOthers { owners })),
    );
    if after.is_empty() {
        safeguards.push(OwnersSafeguard::Ownerless(Ownerless));
    }
    safeguards
}

/// What declaring `added` a parent, as `metadata` now does, risks.
fn add_parent_safeguards(metadata: &Metadata<'_>, added: &ChangeIdRef) -> Result<Vec<AddParentSafeguard>> {
    let ctx = metadata.ctx();
    let mut safeguards = Vec::new();
    if ctx.metadata(added)?.archived && !metadata.archived {
        safeguards.push(AddParentSafeguard::ArchivedParent(ArchivedParent { parent: added.to_owned() }));
    }
    for other in metadata.declared_parents.iter().filter(|other| other.as_ref() != added) {
        if ctx.metadata(other)?.is_descendant(added)? {
            let redundant = RedundantParent { parent: added.to_owned(), descendant: other.clone() };
            safeguards.push(AddParentSafeguard::RedundantParent(redundant));
            break;
        }
    }
    safeguards.extend(no_common_ancestor(metadata)?.map(AddParentSafeguard::NoCommonAncestor));
    Ok(safeguards)
}

/// What removing `removed` from `before`'s parents, as `after` has done, risks.
fn remove_parent_safeguards(
    before: &Metadata<'_>,
    after: &Metadata<'_>,
    removed: &ChangeIdRef,
) -> Result<Vec<RemoveParentSafeguard>> {
    let ctx = after.ctx();
    let mut safeguards = Vec::new();
    let (old, new) = (before.parents()?, after.parents()?);
    let branch = ctx.branch(after.id())?;
    if branch.base(&old)? != branch.base(&new)? {
        safeguards.push(RemoveParentSafeguard::BaseMoves(BaseMoves { removed: removed.to_owned() }));
    }
    if new.is_empty() {
        safeguards.push(RemoveParentSafeguard::Parentless(Parentless));
    }
    safeguards.extend(no_common_ancestor(after)?.map(RemoveParentSafeguard::NoCommonAncestor));
    Ok(safeguards)
}

/// Whether `metadata`'s parents share no ancestor, so could never coalesce into one to land into.
fn no_common_ancestor(metadata: &Metadata<'_>) -> Result<Option<NoCommonAncestor>> {
    let Some(parents) = NEBTreeSet::try_from_set(metadata.parents()?) else { return Ok(None) };
    let mut common: Option<BTreeSet<ChangeId>> = None;
    for parent in &parents {
        let ancestors = ancestors(metadata.ctx(), parent)?;
        common = Some(match common {
            None => ancestors,
            Some(common) => &common & &ancestors,
        });
    }
    Ok(common.is_some_and(|common| common.is_empty()).then_some(NoCommonAncestor { parents }))
}

/// `change_id` and every change it lands through.
fn ancestors<'ctx>(ctx: &'ctx TransactionContext<'ctx>, change_id: &ChangeIdRef) -> Result<BTreeSet<ChangeId>> {
    let mut ancestors = BTreeSet::new();
    let mut frontier = vec![change_id.to_owned()];
    while let Some(id) = frontier.pop() {
        if ancestors.insert(id.clone()) {
            frontier.extend(ctx.metadata(&id)?.parents()?);
        }
    }
    Ok(ancestors)
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
) -> Result<Vec<RebaseSafeguard>> {
    let ctx = metadata.ctx();
    let mut safeguards = Vec::from_iter(non_owner(metadata)?.map(RebaseSafeguard::NonOwner));
    if let Some(files) = NEBTreeSet::try_from_set(branch.conflicted_files(&metadata.parents()?)?) {
        safeguards.push(RebaseSafeguard::Conflicted(Conflicted { files }));
    }
    for target in targets {
        let parent = ctx.branch(target)?;
        // A parent already merged in brings nothing, conflicts included.
        if ctx.is_predecessor(parent.tip, branch.tip)? {
            continue;
        }
        if let Some(files) = NEBTreeSet::try_from_set(parent.conflicted_files(&ctx.metadata(target)?.parents()?)?) {
            safeguards.push(RebaseSafeguard::ParentConflicted(ParentConflicted { parent: target.clone(), files }));
        }
    }
    Ok(safeguards)
}

fn non_owner(metadata: &Metadata<'_>) -> Result<Option<NonOwner>> {
    let you = metadata.ctx().identity()?;
    Ok((!metadata.owners.contains(&you)).then(|| NonOwner { you, owners: metadata.owners.clone() }))
}

/// `a, b, c`.
pub fn joined(items: impl IntoIterator<Item: fmt::Display>) -> String {
    items.into_iter().map(|item| item.to_string()).collect::<Vec<_>>().join(", ")
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

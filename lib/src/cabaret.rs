use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    path::{Path, PathBuf},
};

use cabaret_transaction::{BranchOp, Head, Metadata, Store, WorkspaceOp};
use cabaret_types::{
    ChangeId, ChangeIdRef, ChangeSnapshot, ChangedFile, Identity, Pathspec, RepoPath, Result, Revision, RevisionRange,
    WorkspaceId, WorkspaceIdRef,
};
use gix::bstr::ByteSlice;

use crate::{
    home::{Home, HomeGraph, HomeNode},
    page::Page,
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

    pub fn identity(&self) -> Result<Identity> { self.store.query(|ctx| ctx.identity()) }

    pub fn current_change(&self) -> Result<ChangeId> { self.store.query(|ctx| ctx.current_change()) }

    pub fn resolve(&self, spec: &str) -> Result<Revision> { self.store.query(|ctx| ctx.resolve(spec)) }

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

    pub fn blob(&self, revision: Revision, path: &RepoPath) -> Result<Option<String>> {
        self.store.query(|ctx| ctx.blob(revision, path))
    }

    pub fn base(&self, change_id: &ChangeIdRef) -> Result<Option<Revision>> {
        self.store.query(|ctx| ctx.branch(change_id)?.base(&ctx.metadata(change_id)?.parents()?))
    }

    pub fn changed_files(&self, change_id: &ChangeIdRef, pathspecs: &[Pathspec]) -> Result<Vec<ChangedFile>> {
        self.store.query(|ctx| ctx.branch(change_id)?.changed_files(&ctx.metadata(change_id)?.parents()?, pathspecs))
    }

    pub fn show_page(&self, change_id: &ChangeIdRef) -> Result<Page> {
        self.store.query(|ctx| {
            let change = ctx.snapshot(change_id)?;
            let workspace = match &change.workspace {
                Some(workspace) => Some(ctx.workspace(workspace.to_ref())?.path()),
                None => None,
            };
            Ok(Page::show(change_id, &change, workspace))
        })
    }

    pub fn diff_page(&self, change_id: &ChangeIdRef, pathspecs: &[Pathspec]) -> Result<Page> {
        Ok(Page::diff(change_id, &self.changed_files(change_id, pathspecs)?))
    }

    pub fn create(&self, change_id: &ChangeIdRef, parent_id: &ChangeIdRef, owner: &Identity) -> Result<()> {
        let tip = self.store.query(|ctx| Ok(ctx.branch(parent_id)?.tip))?;
        let branches = [BranchOp::Insert { id: change_id, tip }];
        self.store.transact(&[change_id], &branches, &[], |_ctx, [metadata], [_branch], []| {
            metadata.declared_parents = BTreeSet::from([parent_id.to_owned()]);
            metadata.owners = BTreeSet::from([owner.clone()]);
            Ok(())
        })
    }

    /// Insert `parent_id` between `change_id` and its parents: a new change declaring the parents
    /// `change_id` declared, which then declares only `parent_id`. It starts at `change_id`'s
    /// base, so it is empty against its parents and `change_id`'s diff is unchanged.
    pub fn create_parent(&self, change_id: &ChangeIdRef, parent_id: &ChangeIdRef, owner: &Identity) -> Result<()> {
        let tip = self
            .store
            .query(|ctx| ctx.branch(change_id)?.base(&ctx.metadata(change_id)?.parents()?))?
            .ok_or_else(|| format!("{change_id} has no base to start a parent from"))?;
        let branches = [BranchOp::Insert { id: parent_id, tip }];
        self.store.transact(&[parent_id, change_id], &branches, &[], |_ctx, [parent, child], [_branch], []| {
            parent.declared_parents =
                std::mem::replace(&mut child.declared_parents, BTreeSet::from([parent_id.to_owned()]));
            parent.owners = BTreeSet::from([owner.clone()]);
            Ok(())
        })
    }

    /// Record what the workspace holding `change_id` has on disk at the paths `pathspecs` match,
    /// all when empty, as a new commit on the change, returning it. The commit is named for the
    /// change and nothing more: commits are for the computer, not for reading.
    pub fn commit(&self, change_id: &ChangeIdRef, pathspecs: &[Pathspec]) -> Result<Revision> {
        let workspace_id = self
            .store
            .query(|ctx| ctx.branch(change_id)?.workspace())?
            .ok_or_else(|| format!("{change_id} is not checked out in any workspace"))?;
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

    /// Merge `change_id` into its one parent and archive it unless it is permanent, returning the
    /// parent. Conflicts are refused rather than landed: rebase and resolve them first.
    pub fn land(&self, change_id: &ChangeIdRef) -> Result<ChangeId> {
        let parent_id = self.store.query(|ctx| {
            match ctx.metadata(change_id)?.parents()?.iter().collect::<Vec<_>>().as_slice() {
                [] => Err(format!("{change_id} cannot land while it has no parents"))?,
                [_, _, ..] => Err(format!("{change_id} cannot land while it has multiple parents"))?,
                [parent] => Ok((*parent).clone()),
            }
        })?;
        // The child's branch is declared so it cannot move between the merge and the archive.
        let branches = [BranchOp::Update(&parent_id), BranchOp::Update(change_id)];
        self.store.transact(&[change_id], &branches, &[], |_ctx, [child], [parent, child_branch], []| {
            if child.archived {
                Err(format!("{change_id} is archived"))?;
            }
            match parent.merge(child_branch, "land")? {
                None => Err(format!("{change_id} has nothing to land"))?,
                Some(conflicts) if !conflicts.is_empty() => {
                    Err(format!("{change_id} conflicts with {parent_id}; rebase and resolve first"))?;
                }
                Some(_) => {}
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
    pub fn rebase(&self, change_id: &ChangeIdRef, onto: Option<&ChangeIdRef>) -> Result<Rebase> {
        self.store.update_branch(change_id, |ctx, branch| {
            let parents = ctx.metadata(change_id)?.parents()?;
            let targets = match onto {
                None if parents.is_empty() => Err(format!("{change_id} has no parents to rebase onto"))?,
                None => parents,
                Some(onto) if parents.contains(onto) => BTreeSet::from([onto.to_owned()]),
                Some(onto) => Err(format!("{onto} is not a parent of {change_id}"))?,
            };

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

    pub fn remove_owner(&self, change_id: &ChangeIdRef, owner: &Identity) -> Result<()> {
        self.store.update_metadata(change_id, |_ctx, metadata| match metadata.owners.remove(owner) {
            false => Err(format!("{owner} did not own {change_id}"))?,
            true if metadata.owners.len() == 0 => Err(format!("{owner} was {change_id}'s only owner"))?,
            true => Ok(()),
        })
    }

    pub fn set_owners(&self, change_id: &ChangeIdRef, owners: BTreeSet<Identity>) -> Result<()> {
        self.store.update_metadata(change_id, |_ctx, metadata| match metadata.owners == owners {
            true => Err(format!("{change_id} already had these owners"))?,
            false if owners.len() == 0 => Err(format!("{change_id} should have at least one owner"))?,
            false => Ok(metadata.owners = owners),
        })
    }

    // TODO(joel): some helper that aligns the parent set with the derived parent set?

    pub fn add_parent(&self, change_id: &ChangeIdRef, parent_id: &ChangeIdRef) -> Result<()> {
        self.store.update_metadata(change_id, |ctx, metadata| {
            // TODO(joel): check for cyclic dependencies
            match metadata.declared_parents.insert(parent_id.to_owned()) {
                false => Err(format!("{parent_id} was already a parent of {change_id}"))?,
                true => Ok(()),
            }
        })
    }

    pub fn remove_parent(&self, change_id: &ChangeIdRef, parent_id: &ChangeIdRef) -> Result<()> {
        self.store.update_metadata(change_id, |_ctx, metadata| match metadata.declared_parents.remove(parent_id) {
            false => Err(format!("{parent_id} was not a parent of {change_id}"))?,
            true => Ok(()),
        })
    }

    /// Record that this repository's identity has reviewed `files` of `change_id` from `bases` up
    /// to `head`; each defaults to the change's own.
    pub fn mark(
        &self,
        change_id: &ChangeIdRef,
        files: &[RepoPath],
        head: Option<Revision>,
        bases: Option<BTreeSet<Revision>>,
    ) -> Result<()> {
        self.store.update_metadata(change_id, |ctx, metadata| {
            let branch = ctx.branch(change_id)?;
            let bases = match bases {
                Some(bases) => bases,
                None => branch.bases(&metadata.parents()?)?,
            };
            let range = RevisionRange { bases, head: head.unwrap_or(branch.tip) };
            let review = metadata.review.entry(ctx.identity()?).or_default();
            if files.iter().all(|file| review.get(file) == Some(&range)) {
                Err(format!("{change_id} already had these files marked reviewed there"))?;
            }
            review.extend(files.iter().map(|file| (file.clone(), range.clone())));
            Ok(())
        })
    }

    pub fn set_title(&self, change_id: &ChangeIdRef, title: Option<String>) -> Result<()> {
        self.store.update_metadata(change_id, |_ctx, metadata| match metadata.title == title {
            true => Err(format!("{change_id} already had this title"))?,
            false => Ok(metadata.title = title),
        })
    }

    pub fn set_description(&self, change_id: &ChangeIdRef, description: Option<String>) -> Result<()> {
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
    /// The changes `viewer` owns that are still open, since owners are to push those forward,
    /// and every change checked out in this device's workspaces, archived or not, since those
    /// are still active here; each with its ancestors as context.
    pub fn home(&self, viewer: &Identity) -> Result<Home> {
        self.store.query(|ctx| {
            let trunk = ctx.default_branch()?;
            let mut changes = BTreeMap::new();
            for id in ctx.changes()? {
                changes.insert(id.clone(), ctx.metadata(&id)?);
            }
            let owned = changes
                .iter()
                .filter(|(_, metadata)| !metadata.archived && metadata.owners.contains(viewer))
                .map(|(id, _)| id.clone());
            let mut checked_out = BTreeSet::new();
            for workspace in ctx.workspaces()? {
                let change = ctx.workspace(workspace.to_ref())?.change();
                checked_out.extend(change.filter(|id| changes.contains_key(*id)).cloned());
            }
            Ok(Home {
                viewer: viewer.clone(),
                owned: home_graph(&changes, &owned.collect(), &trunk)?,
                workspaces: home_graph(&changes, &checked_out, &trunk)?,
            })
        })
    }

    pub fn home_page(&self, viewer: &Identity) -> Result<Page> { Page::home(&self.home(viewer)?) }
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

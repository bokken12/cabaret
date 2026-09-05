use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use gix::{ThreadSafeRepository, bstr::ByteSlice};

use crate::{
    error::Result,
    page::Page,
    transaction::{BranchOp, WorkspaceOp, workspace::Head},
    types::{
        ChangeId, ChangeIdRef, ChangeSnapshot, ChangedFile, Identity, Pathspec, RepoPath, Revision, RevisionRange,
        WorkspaceId, WorkspaceIdRef,
    },
};

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
    pub(crate) repo: ThreadSafeRepository,
    /// Where transactions lock changes; under the common dir so every workspace shares them.
    pub(crate) locks: PathBuf,
}

impl Cabaret {
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> {
        let repo = ThreadSafeRepository::discover(dir)?;
        let locks = repo.to_thread_local().common_dir().join("cabaret").join("locks");
        Ok(Self { repo, locks })
    }

    // Workspace operations

    /// Every workspace and the change checked out in it, `None` where HEAD is detached.
    pub fn workspaces(&self) -> Result<BTreeMap<WorkspaceId, Option<ChangeId>>> {
        self.query(|ctx| {
            let mut workspaces = BTreeMap::new();
            for workspace in ctx.workspaces()? {
                let change = ctx.workspace(workspace.to_ref())?.change().cloned();
                workspaces.insert(workspace, change);
            }
            Ok(workspaces)
        })
    }

    pub fn workspace_holding(&self, change_id: &ChangeIdRef) -> Result<Option<WorkspaceId>> {
        self.query(|ctx| ctx.branch(change_id)?.workspace())
    }

    /// The workspace whose working directory is `path`.
    pub fn workspace_at(&self, path: &Path) -> Result<WorkspaceId> {
        let path = fs::canonicalize(path)?;
        self.query(|ctx| {
            for workspace in ctx.workspaces()? {
                let workdir = ctx.workspace(workspace.to_ref())?.path().ok().and_then(|dir| fs::canonicalize(dir).ok());
                if workdir.as_deref() == Some(&path) {
                    return Ok(workspace);
                }
            }
            Err(format!("no workspace at {}", path.display()).into())
        })
    }

    /// The workspace this instance was opened in.
    pub fn workspace_current(&self) -> Result<WorkspaceId> { self.query(|ctx| ctx.current_workspace()) }

    pub fn workspace_path(&self, workspace_id: WorkspaceIdRef<'_>) -> Result<PathBuf> {
        self.query(|ctx| Ok(ctx.workspace(workspace_id)?.path()?.to_owned()))
    }

    /// Create a workspace holding `change_id` at `path`, or the default location, and return
    /// where it was made. Declaring the branch keeps it still while the files are written.
    pub fn workspace_add(&self, change_id: ChangeId, path: Option<PathBuf>) -> Result<PathBuf> {
        let path = match path {
            Some(path) => std::path::absolute(path)?,
            None => self.default_workspace_path(&change_id)?,
        };
        self.transact(
            &[],
            &[BranchOp::Update(&change_id)],
            &[WorkspaceOp::Insert { path: &path, head: Head::Change(change_id.clone()) }],
            |_ctx, [], [_branch], [_workspace]| Ok(()),
        )?;
        Ok(path)
    }

    /// Beside the main workspace as `<name>-<change>`, so checkouts of several repositories can
    /// share a parent directory; inside the git dir when the repository is bare.
    fn default_workspace_path(&self, change_id: &ChangeIdRef) -> Result<PathBuf> {
        let main = self.repo.to_thread_local().main_repo()?;
        // a change id may contain slashes, which one directory name cannot
        let change = gix::path::from_bstring(change_id.as_bstr().replace("/", "-"));
        let Some(workdir) = main.workdir() else {
            return Ok(main.git_dir().join(change));
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
        match self.query(|ctx| Ok(ctx.workspace(workspace_id)?.change().cloned()))? {
            Some(held) => {
                self.transact(&[], &[BranchOp::Update(&held)], &delete, |_ctx, [], [_branch], [_workspace]| Ok(()))
            }
            None => self.transact(&[], &[], &delete, |_ctx, [], [], [_workspace]| Ok(())),
        }
    }

    pub fn workspace_switch(&self, workspace_id: WorkspaceIdRef<'_>, change_id: ChangeId) -> Result<()> {
        self.transact(
            &[],
            &[BranchOp::Update(&change_id)],
            &[WorkspaceOp::Update { id: workspace_id }],
            |_ctx, [], [_branch], [workspace]| {
                workspace.head = Head::Change(change_id.clone());
                Ok(())
            },
        )
    }

    // Change operations

    pub fn changes(&self) -> Result<Vec<ChangeId>> { self.query(|ctx| ctx.changes()) }

    pub fn identity(&self) -> Result<Identity> { self.query(|ctx| ctx.identity()) }

    pub fn current_change(&self) -> Result<ChangeId> { self.query(|ctx| ctx.current_change()) }

    pub fn resolve(&self, spec: &str) -> Result<Revision> { self.query(|ctx| ctx.resolve(spec)) }

    pub fn snapshot(&self, change_id: &ChangeIdRef) -> Result<ChangeSnapshot> {
        self.query(|ctx| ctx.snapshot(change_id))
    }

    pub fn blob(&self, revision: Revision, path: &RepoPath) -> Result<Option<String>> {
        self.query(|ctx| ctx.blob(revision, path))
    }

    pub fn base(&self, change_id: &ChangeIdRef) -> Result<Option<Revision>> {
        self.query(|ctx| ctx.branch(change_id)?.base(&ctx.metadata(change_id)?.parents()?))
    }

    pub fn changed_files(&self, change_id: &ChangeIdRef, pathspecs: &[Pathspec]) -> Result<Vec<ChangedFile>> {
        self.query(|ctx| ctx.branch(change_id)?.changed_files(&ctx.metadata(change_id)?.parents()?, pathspecs))
    }

    pub fn show_page(&self, change_id: &ChangeIdRef) -> Result<Page> {
        Ok(Page::show(change_id, &self.snapshot(change_id)?))
    }

    pub fn diff_page(&self, change_id: &ChangeIdRef, pathspecs: &[Pathspec]) -> Result<Page> {
        Ok(Page::diff(change_id, &self.changed_files(change_id, pathspecs)?))
    }

    pub fn create(&self, change_id: &ChangeIdRef, parent_id: &ChangeIdRef, owner: &Identity) -> Result<()> {
        let tip = self.query(|ctx| Ok(ctx.branch(parent_id)?.tip))?;
        let branches = [BranchOp::Insert { id: change_id, tip }];
        self.transact(&[change_id], &branches, &[], |_ctx, [metadata], [_branch], []| {
            metadata.declared_parents = BTreeSet::from([parent_id.to_owned()]);
            metadata.owners = BTreeSet::from([owner.clone()]);
            Ok(())
        })
    }

    /// Merge `change_id` into its one parent and archive it unless it is permanent, returning the
    /// parent. Conflicts are refused rather than landed: rebase and resolve them first.
    pub fn land(&self, change_id: &ChangeIdRef) -> Result<ChangeId> {
        let parent_id =
            self.query(|ctx| match ctx.metadata(change_id)?.parents()?.iter().collect::<Vec<_>>().as_slice() {
                [] => Err(format!("{change_id} cannot land while it has no parents"))?,
                [_, _, ..] => Err(format!("{change_id} cannot land while it has multiple parents"))?,
                [parent] => Ok((*parent).clone()),
            })?;
        // The child's branch is declared so it cannot move between the merge and the archive.
        let branches = [BranchOp::Update(&parent_id), BranchOp::Update(change_id)];
        self.transact(&[change_id], &branches, &[], |_ctx, [child], [parent, child_branch], []| {
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
        self.update_branch(change_id, |ctx, branch| {
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
        self.update_metadata(change_id, |_ctx, metadata| {
            // TODO(joel): warn if children unarchived?
            match metadata.archived {
                true => Err(format!("{change_id} has already been archived"))?,
                false => metadata.archived = true,
            };
            Ok(())
        })
    }

    pub fn unarchive(&self, change_id: &ChangeIdRef) -> Result<()> {
        self.update_metadata(change_id, |_ctx, metadata| {
            // TODO(joel): warn if parents archived?
            match metadata.archived {
                false => Err(format!("{change_id} has not been archived"))?,
                true => metadata.archived = false,
            };
            Ok(())
        })
    }

    pub fn add_owner(&self, change_id: &ChangeIdRef, owner: &Identity) -> Result<()> {
        self.update_metadata(change_id, |_ctx, metadata| match metadata.owners.insert(owner.clone()) {
            false => Err(format!("{owner} already owned {change_id}"))?,
            true => Ok(()),
        })
    }

    pub fn remove_owner(&self, change_id: &ChangeIdRef, owner: &Identity) -> Result<()> {
        self.update_metadata(change_id, |_ctx, metadata| match metadata.owners.remove(owner) {
            false => Err(format!("{owner} did not own {change_id}"))?,
            true if metadata.owners.len() == 0 => Err(format!("{owner} was {change_id}'s only owner"))?,
            true => Ok(()),
        })
    }

    pub fn set_owners(&self, change_id: &ChangeIdRef, owners: BTreeSet<Identity>) -> Result<()> {
        self.update_metadata(change_id, |_ctx, metadata| match metadata.owners == owners {
            true => Err(format!("{change_id} already had these owners"))?,
            false if owners.len() == 0 => Err(format!("{change_id} should have at least one owner"))?,
            false => Ok(metadata.owners = owners),
        })
    }

    // TODO(joel): some helper that aligns the parent set with the derived parent set?

    pub fn add_parent(&self, change_id: &ChangeIdRef, parent_id: &ChangeIdRef) -> Result<()> {
        self.update_metadata(change_id, |ctx, metadata| {
            // TODO(joel): check for cyclic dependencies
            match metadata.declared_parents.insert(parent_id.to_owned()) {
                false => Err(format!("{parent_id} was already a parent of {change_id}"))?,
                true => Ok(()),
            }
        })
    }

    pub fn remove_parent(&self, change_id: &ChangeIdRef, parent_id: &ChangeIdRef) -> Result<()> {
        self.update_metadata(change_id, |_ctx, metadata| match metadata.declared_parents.remove(parent_id) {
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
        self.update_metadata(change_id, |ctx, metadata| {
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
        self.update_metadata(change_id, |_ctx, metadata| match metadata.title == title {
            true => Err(format!("{change_id} already had this title"))?,
            false => Ok(metadata.title = title),
        })
    }

    pub fn set_description(&self, change_id: &ChangeIdRef, description: Option<String>) -> Result<()> {
        self.update_metadata(change_id, |_ctx, metadata| match metadata.description == description {
            true => Err(format!("{change_id} already had this description"))?,
            false => Ok(metadata.description = description),
        })
    }

    pub fn set_permanent(&self, change_id: &ChangeIdRef, permanent: bool) -> Result<()> {
        self.update_metadata(change_id, |_ctx, metadata| {
            // TODO(joel): warn if parents non-permanent?
            match metadata.archived {
                true => Err(format!("{change_id} is archived"))?,
                _ => metadata.permanent = permanent,
            };
            Ok(())
        })
    }
}

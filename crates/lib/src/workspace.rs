use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use cabaret_transaction::{BranchOp, Head, Status, Workspace, WorkspaceOp};
use cabaret_types::{
    ChangeId, ChangeIdRef, Result, WorkspaceId, WorkspaceIdRef,
    safeguard::{Allow, Safeguard, SafeguardKind, Uncommitted},
};
use gix::bstr::ByteSlice;

use crate::cabaret::Cabaret;

/// What [`Cabaret::workspace_prune`] did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Prune {
    pub removed: BTreeSet<WorkspaceId>,
    /// Workspaces of archived changes left standing, each with why it could not go.
    pub kept: BTreeMap<WorkspaceId, String>,
}

impl Cabaret {
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

    /// The git directory every workspace of the repository shares, where changes are recorded.
    pub fn common_dir(&self) -> PathBuf { self.store.repo.to_thread_local().common_dir().to_owned() }

    /// The workspace this instance was opened in.
    pub fn workspace_current(&self) -> Result<WorkspaceId> { self.store.query(|ctx| ctx.current_workspace()) }

    pub fn workspace_path(&self, workspace_id: WorkspaceIdRef<'_>) -> Result<PathBuf> {
        self.store.query(|ctx| Ok(ctx.workspace(workspace_id)?.path().to_owned()))
    }

    /// Create a workspace holding `change_id` at `path`, or the default location, and return
    /// where it was made. Declaring the branch keeps it still while the files are written.
    pub fn workspace_add(&self, change_id: &ChangeIdRef, path: Option<PathBuf>) -> Result<PathBuf> {
        let path = match path {
            Some(path) => std::path::absolute(path)?,
            None => self.default_workspace_path(change_id)?,
        };
        self.store.transact(
            &[],
            &[BranchOp::Update(change_id)],
            &[WorkspaceOp::Insert { path: &path, head: Head::Change(change_id.to_owned()) }],
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

    /// The safeguards that would refuse removing `workspace_id` now, for a frontend to ask about first.
    pub fn workspace_remove_safeguards(&self, workspace_id: WorkspaceIdRef<'_>) -> Result<Vec<Safeguard>> {
        self.store.query(|ctx| remove_workspace_safeguards(ctx.workspace(workspace_id)?))
    }

    /// Remove `workspace_id`; allowing uncommitted changes deletes them with it. Removing a
    /// workspace needs the branch it holds, which is only known once read; the transaction
    /// re-checks it under the lock.
    pub fn workspace_remove(&self, workspace_id: WorkspaceIdRef<'_>, allow: &Allow) -> Result<()> {
        let delete = [WorkspaceOp::Delete { id: workspace_id }];
        let remove = |workspace: &mut Workspace<'_>| {
            if workspace_id == WorkspaceIdRef::Main {
                Err("the main workspace cannot be removed")?;
            }
            allow.check(remove_workspace_safeguards(workspace)?)?;
            workspace.drop_local_changes = allow.allows(SafeguardKind::Uncommitted);
            Ok(())
        };
        match self.store.query(|ctx| Ok(ctx.workspace(workspace_id)?.change().cloned()))? {
            Some(held) => {
                self.store.transact(&[], &[BranchOp::Update(&held)], &delete, |_ctx, [], [_branch], [workspace]| {
                    remove(workspace)
                })
            }
            None => self.store.transact(&[], &[], &delete, |_ctx, [], [], [workspace]| remove(workspace)),
        }
    }

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

    /// Check out `change_id` in `workspace_id`; allowing uncommitted changes drops those to
    /// tracked files, leaving untracked ones be. Switching needs the branch the workspace leaves,
    /// which is only known once read; the transaction re-checks it under the lock.
    pub fn workspace_switch(
        &self,
        workspace_id: WorkspaceIdRef<'_>,
        change_id: &ChangeIdRef,
        allow: &Allow,
    ) -> Result<()> {
        let update = [WorkspaceOp::Update { id: workspace_id }];
        let switch = |workspace: &mut Workspace<'_>| {
            // Untracked files are left where they are, so only changes to tracked ones are at risk.
            if workspace.status()? == Status::Modified {
                let uncommitted = Uncommitted { workspace: workspace_id.into_owned() };
                allow.check(vec![Safeguard::Uncommitted(uncommitted)])?;
            }
            workspace.drop_local_changes = allow.allows(SafeguardKind::Uncommitted);
            workspace.head = Head::Change(change_id.to_owned());
            Ok(())
        };
        let held = self.store.query(|ctx| Ok(ctx.workspace(workspace_id)?.change().cloned()))?;
        match held.filter(|held| **held != *change_id) {
            Some(held) => self.store.transact(
                &[],
                &[BranchOp::Update(change_id), BranchOp::Update(&held)],
                &update,
                |_ctx, [], [_to, _from], [workspace]| switch(workspace),
            ),
            None => {
                self.store.transact(&[], &[BranchOp::Update(change_id)], &update, |_ctx, [], [_to], [workspace]| {
                    switch(workspace)
                })
            }
        }
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
}

fn remove_workspace_safeguards(workspace: &Workspace<'_>) -> Result<Vec<Safeguard>> {
    Ok(match workspace.status()? {
        Status::Clean => Vec::new(),
        Status::Untracked | Status::Modified => {
            vec![Safeguard::Uncommitted(Uncommitted { workspace: workspace.id().into_owned() })]
        }
    })
}

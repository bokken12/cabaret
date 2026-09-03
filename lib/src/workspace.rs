//! Workspaces: the working directories of the repository, each holding at most one checked-out
//! change. Git refuses to check one branch out twice, so a change has at most one workspace.
//! When a change's branch moves, its workspace must move with it, or git would show the whole
//! change as undone locally.

use std::process::Command;

use gix::{Repository, bstr::ByteSlice};

use crate::{
    change::Change,
    context::TransactionContext,
    error::Result,
    types::{ChangeId, Revision, WorkspaceId},
};

impl TransactionContext<'_> {
    /// Every workspace: the main one unless the repository is bare, then each linked worktree.
    pub fn workspaces(&self) -> Result<Vec<WorkspaceId>> {
        let mut workspaces = Vec::new();
        if self.repo.main_repo()?.workdir().is_some() {
            workspaces.push(WorkspaceId::Main);
        }
        for proxy in self.repo.worktrees()? {
            workspaces.push(WorkspaceId::Linked(proxy.id().to_owned()));
        }
        Ok(workspaces)
    }

    /// The repository as seen from `workspace`: its HEAD, index, and working directory. The
    /// directory itself may be missing if the worktree was moved or deleted outside git.
    pub fn workspace_repo(&self, workspace: &WorkspaceId) -> Result<Repository> {
        match workspace {
            WorkspaceId::Main => Ok(self.repo.main_repo()?),
            WorkspaceId::Linked(id) => {
                let proxy = self.repo.worktree_proxy_by_id(id.as_bstr()).ok_or_else(|| format!("no workspace {id}"))?;
                Ok(proxy.into_repo_with_possibly_inaccessible_worktree()?)
            }
        }
    }

    // TODO-someday(joel): move to proper gix?
    /// Move a clean `workspace` from `from` to `to`, touching only the paths that differ and
    /// refusing to overwrite untracked files in the way.
    pub fn checkout(&self, workspace: &WorkspaceId, from: Revision, to: Revision) -> Result<()> {
        let repo = self.workspace_repo(workspace)?;
        if repo.is_dirty()? {
            Err(format!("workspace {workspace} has uncommitted changes"))?;
        }
        let workdir = repo.workdir().ok_or_else(|| format!("workspace {workspace} has no working directory"))?;
        let git = |args: &[&str]| -> Result<()> {
            let output = Command::new("git").arg("-C").arg(workdir).args(args).output()?;
            match output.status.success() {
                true => Ok(()),
                false => {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    Err(stderr.trim().strip_prefix("error: ").unwrap_or(stderr.trim()))?
                }
            }
        };
        // gix can only write a whole index, so the two-tree update is git's job. read-tree trusts
        // the index's stat data rather than re-hashing, so it is refreshed first.
        git(&["update-index", "-q", "--refresh"])?;
        git(&["read-tree", "-m", "-u", &from.to_string(), &to.to_string()])
    }

    /// The change checked out in `workspace`, or `None` when its HEAD is detached.
    pub fn workspace_change(&self, workspace: &WorkspaceId) -> Result<Option<ChangeId>> {
        match self.workspace_repo(workspace)?.head_name()? {
            Some(head) => Ok(Some(head.shorten().to_str()?.parse()?)),
            None => Ok(None),
        }
    }
}

impl Change<'_> {
    /// The workspace with this change checked out, if any.
    pub fn workspace(&self) -> Result<Option<WorkspaceId>> {
        let ctx = self.ctx();
        for workspace in ctx.workspaces()? {
            if ctx.workspace_change(&workspace)?.as_deref() == Some(self.id()) {
                return Ok(Some(workspace));
            }
        }
        Ok(None)
    }
}

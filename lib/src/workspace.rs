//! Workspaces: the working directories of the repository, each holding at most one checked-out
//! change. Git refuses to check one branch out twice, so a change has at most one workspace.

use gix::{Repository, bstr::ByteSlice};

use crate::{
    change::Change,
    context::TransactionContext,
    error::Result,
    types::{ChangeId, WorkspaceId},
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

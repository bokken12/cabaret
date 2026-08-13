use std::path::PathBuf;

use gix::{Repository, bstr::ByteSlice, refs::FullName};

use crate::{cabaret::Cabaret, error::Result, types::ChangeId};

impl Cabaret {
    /// The workspace repository that has `branch` checked out, if any.
    pub fn workspace_holding(&self, branch: &FullName) -> Result<Option<Repository>> {
        let mut repos = vec![self.repo.main_repo()?];
        for proxy in self.repo.worktrees()? {
            repos.push(proxy.into_repo_with_possibly_inaccessible_worktree()?);
        }
        for repo in repos {
            if repo.workdir().is_some() && repo.head_name()?.is_some_and(|head| head == *branch) {
                return Ok(Some(repo));
            }
        }
        Ok(None)
    }

    /// Linked workspaces and the change each has checked out, sorted by change.
    pub fn workspaces(&self) -> Result<Vec<(ChangeId, PathBuf)>> {
        let mut workspaces = Vec::new();
        for proxy in self.repo.worktrees()? {
            let repo = proxy.into_repo_with_possibly_inaccessible_worktree()?;
            let (Some(workdir), Some(head)) = (repo.workdir(), repo.head_name()?) else { continue };
            workspaces.push((head.shorten().to_str()?.parse()?, workdir.to_owned()));
        }
        workspaces.sort();
        Ok(workspaces)
    }

    /// Create a workspace with `change`'s branch checked out and return its path.
    pub fn add_workspace(&self, change: &ChangeId) -> Result<PathBuf> {
        self.tip(change)?;
        let path = self.workspace_path(change)?;
        let mut command = self.git();
        command.args(["worktree", "add", "--quiet"]).arg(&path).arg(change.to_string());
        if !command.status()?.success() {
            return Err("git worktree add failed".into());
        }
        Ok(path)
    }

    /// Remove the workspace that has `change`'s branch checked out and return its path.
    pub fn remove_workspace(&self, change: &ChangeId) -> Result<PathBuf> {
        let workspace =
            self.workspace_holding(&change.branch_ref())?.ok_or_else(|| format!("{change} has no workspace"))?;
        if workspace.worktree().is_some_and(|worktree| worktree.is_main()) {
            return Err(format!("{change} is checked out in the main workspace").into());
        }
        let workdir = workspace.workdir().expect("held branches have a workdir").to_owned();
        let mut command = self.git();
        command.args(["worktree", "remove"]).arg(&workdir);
        if !command.status()?.success() {
            return Err("git worktree remove failed".into());
        }
        Ok(workdir)
    }

    /// Bare repositories keep workspaces inside the git dir; otherwise workspaces sit adjacent
    /// to the main workspace as `<name>-<change>`.
    fn workspace_path(&self, change: &ChangeId) -> Result<PathBuf> {
        let main = self.repo.main_repo()?;
        let Some(workdir) = main.workdir() else {
            return Ok(main.git_dir().join(change.to_string()));
        };
        let mut name = workdir.file_name().ok_or("main workspace has no directory name")?.to_os_string();
        name.push("-");
        name.push(change.to_string());
        Ok(workdir.parent().ok_or("main workspace has no parent directory")?.join(name))
    }
}

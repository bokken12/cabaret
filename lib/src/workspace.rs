use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use gix::{
    Repository,
    bstr::{BString, ByteSlice},
};

use crate::{
    cabaret::Cabaret,
    error::Result,
    revision::Revision,
    types::{ChangeId, TreeId},
};

fn prune_empty_dirs(workdir: &Path, mut dir: &Path) {
    while dir != workdir && fs::remove_dir(dir).is_ok() {
        dir = dir.parent().expect("pruning stops at the worktree root");
    }
}

impl Cabaret {
    /// Make the (clean) worktree and index of `repo`'s workspace match `tree`.
    // TODO-someday(joel): apply only the delta between the old and new trees; rewriting every
    // file on each merge won't fly in a large repository.
    pub fn checkout(&self, tree: TreeId) -> Result<()> {
        let workdir = self.repo.workdir().ok_or("workspace has no working directory")?;
        let mut index = self.repo.index_from_tree(&tree.0)?;

        let old = self.repo.open_index()?;
        let keep: BTreeSet<BString> = index.entries().iter().map(|entry| entry.path(&index).to_owned()).collect();
        for entry in old.entries() {
            let path = entry.path(&old);
            if !keep.contains(path.as_bstr()) {
                let path = workdir.join(gix::path::from_bstr(path));
                fs::remove_file(&path)?;
                prune_empty_dirs(workdir, path.parent().expect("worktree files have a parent"));
            }
        }

        let mut options = self.repo.checkout_options(gix::worktree::stack::state::attributes::Source::IdMapping)?;
        options.overwrite_existing = true;
        gix::worktree::state::checkout(
            &mut index,
            workdir,
            self.repo.objects.clone().into_arc()?,
            &gix::progress::Discard,
            &gix::progress::Discard,
            &gix::interrupt::IS_INTERRUPTED,
            options,
        )?;
        index.write(gix::index::write::Options::default())?;
        Ok(())
    }

    // TODO(joel): is this expensive?
    /// The workspace repository that has `branch` checked out, if any.
    pub fn workspace_holding(&self, change: &ChangeId) -> Result<Option<Repository>> {
        let mut repos = vec![self.repo.main_repo()?];
        for proxy in self.repo.worktrees()? {
            repos.push(proxy.into_repo_with_possibly_inaccessible_worktree()?);
        }
        let branch = change.branch_ref();
        for repo in repos {
            if repo.workdir().is_some() && repo.head_name()?.is_some_and(|head| head == branch) {
                return Ok(Some(repo));
            }
        }
        Ok(None)
    }

    /// The workspace holding `change`'s branch, if any, refusing when it has uncommitted changes.
    pub fn clean_workspace_holding(&self, change: &ChangeId) -> Result<Option<Repository>> {
        let Some(workspace) = self.workspace_holding(change)? else {
            return Ok(None);
        };
        if workspace.is_dirty()? {
            return Err(format!(
                "{change} has uncommitted changes in workspace {}",
                workspace.workdir().expect("held branches have a workdir").display()
            )
            .into());
        }
        Ok(Some(workspace))
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
        let tip = self.tip(change)?;
        if self.workspace_holding(&change)?.is_some() {
            return Err(format!("{change} is already checked out in a workspace").into());
        }
        let path = std::path::absolute(self.workspace_path(change)?)?;
        let worktrees = self.repo.common_dir().join("worktrees");
        let admin = std::path::absolute(worktrees.join(path.file_name().expect("workspace paths name a directory")))?;

        fs::create_dir(&path).map_err(|error| format!("cannot create workspace at {}: {error}", path.display()))?;
        if let Err(error) = fs::create_dir_all(&worktrees).and_then(|()| fs::create_dir(&admin)) {
            let _ = fs::remove_dir(&path);
            return Err(format!("cannot register workspace at {}: {error}", admin.display()).into());
        }
        if let Err(error) = populate_workspace(change, tip, &path, &admin) {
            let _ = fs::remove_dir_all(&path);
            let _ = fs::remove_dir_all(&admin);
            return Err(error);
        }
        Ok(path)
    }

    /// Remove the workspace that has `change`'s branch checked out and return its path.
    pub fn remove_workspace(&self, change: &ChangeId) -> Result<PathBuf> {
        let workspace = self.workspace_holding(&change)?.ok_or_else(|| format!("{change} has no workspace"))?;
        if let Some(worktree) = workspace.worktree() {
            if worktree.is_main() {
                return Err(format!("{change} is checked out in the main workspace").into());
            }
            if worktree.is_locked() {
                return Err(format!("{change}'s workspace is locked").into());
            }
        }
        if let Some(entry) = workspace.status(gix::progress::Discard)?.into_iter(None::<BString>)?.next() {
            entry?;
            return Err(format!("{change}'s workspace has uncommitted or untracked changes").into());
        }
        let workdir = workspace.workdir().expect("held branches have a workdir").to_owned();
        fs::remove_dir_all(&workdir)?;
        fs::remove_dir_all(workspace.git_dir())?;
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

/// Write the linked-worktree metadata git expects and check out `tip`, as `git worktree add` would.
fn populate_workspace(change: &ChangeId, tip: Revision, path: &Path, admin: &Path) -> Result<()> {
    fs::write(admin.join("HEAD"), format!("ref: {}\n", change.branch_ref().as_bstr()))?;
    fs::write(admin.join("commondir"), "../..\n")?;
    fs::write(admin.join("gitdir"), format!("{}\n", path.join(".git").display()))?;
    fs::write(path.join(".git"), format!("gitdir: {}\n", admin.display()))?;

    let repo = gix::open(path)?;
    let tree = repo.find_commit(tip)?.tree_id()?;
    let mut index = repo.index_from_tree(&tree)?;
    let mut options = repo.checkout_options(gix::worktree::stack::state::attributes::Source::IdMapping)?;
    options.destination_is_initially_empty = true;
    gix::worktree::state::checkout(
        &mut index,
        repo.workdir().expect("the new workspace has a working directory"),
        repo.objects.clone().into_arc()?,
        &gix::progress::Discard,
        &gix::progress::Discard,
        &gix::interrupt::IS_INTERRUPTED,
        options,
    )?;
    index.write(gix::index::write::Options::default())?;
    Ok(())
}

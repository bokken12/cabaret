use std::{
    borrow::Borrow,
    collections::BTreeSet,
    fmt, fs,
    ops::Deref,
    path::{Path, PathBuf},
};

use gix::{
    Repository,
    bstr::{BStr, BString, ByteSlice},
    refs::{FullName, TargetRef},
};
use ref_cast::RefCast;

use crate::{
    cabaret::Cabaret,
    change::{ChangeId, ChangeIdRef},
    error::Result,
    revision::Revision,
    types::TreeId,
};

// TODO(joel): extract to util crate
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct WorkspaceId(BString);

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord, RefCast)]
#[repr(transparent)]
pub struct WorkspaceIdRef(BStr);

impl Borrow<WorkspaceIdRef> for WorkspaceId {
    fn borrow(&self) -> &WorkspaceIdRef { WorkspaceIdRef::ref_cast(self.0.as_ref()) }
}

impl AsRef<WorkspaceIdRef> for WorkspaceId {
    fn as_ref(&self) -> &WorkspaceIdRef { self.borrow() }
}

impl Deref for WorkspaceId {
    type Target = WorkspaceIdRef;

    fn deref(&self) -> &Self::Target { self.borrow() }
}

impl ToOwned for WorkspaceIdRef {
    type Owned = WorkspaceId;

    fn to_owned(&self) -> Self::Owned { WorkspaceId(self.0.to_owned()) }
}

impl fmt::Display for WorkspaceIdRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { self.0.fmt(f) }
}

impl fmt::Display for WorkspaceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { self.as_ref().fmt(f) }
}

fn prune_empty_dirs(workdir: &Path, mut dir: &Path) {
    while dir != workdir && fs::remove_dir(dir).is_ok() {
        dir = dir.parent().expect("pruning stops at the worktree root");
    }
}

impl WorkspaceIdRef {
    fn head_ref(&self) -> FullName {
        FullName::try_from(format!("worktrees/{self}/HEAD")).expect("worktree produces valid ref")
    }
}

impl Cabaret {
    pub fn workspaces(&self) -> Result<Vec<WorkspaceId>> {
        Ok(self.repo.worktrees()?.into_iter().map(|proxy| WorkspaceId(proxy.id().to_owned())).collect())
    }

    pub fn change_within(&self, workspace: &WorkspaceIdRef) -> Result<Option<ChangeId>> {
        match self.repo.find_reference(&workspace.head_ref())?.target() {
            TargetRef::Object(_) => Ok(None), // detached
            TargetRef::Symbolic(branch) => Ok(Some(ChangeId(branch.as_partial_name().to_owned()))),
        }
    }

    pub fn workspace_holding(&self, change: &ChangeIdRef) -> Result<Option<WorkspaceId>> {
        Ok(self.workspaces()?.into_iter().find(|workspace| {
            self.change_within(workspace)
                .is_ok_and(|within_opt| within_opt.is_some_and(|within| within.as_ref() == change))
        }))
    }

    // TODO(joel): update this abstraction
    pub fn workspace_repo(&self, workspace: &WorkspaceIdRef) -> Result<Repository> {
        let Some(proxy) = self.repo.worktree_proxy_by_id(&workspace.0) else {
            return Err(format!("{workspace} not present on device!").into());
        };

        Ok(proxy.into_repo()?)
    }

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

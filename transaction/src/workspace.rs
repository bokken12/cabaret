//! Workspaces: the working directories of the repository, each holding at most one checked-out
//! change. Git refuses to check one branch out twice, so a change has at most one workspace.
//! When a change's branch moves, its workspace must move with it, or git would show the whole
//! change as undone locally.
// TODO(joel): this file is not as well reviewed as it could be

use std::{
    collections::BTreeSet,
    convert::Infallible,
    fmt, fs, io,
    ops::ControlFlow,
    path::{Path, PathBuf},
};

use cabaret_types::{ChangeId, Pathspec, Result, Revision, TreeId, WorkspaceId, WorkspaceIdRef};
use gix::{
    Repository, Tree,
    bstr::{BString, ByteSlice},
    index::entry::{Flags, Stat},
    objs::tree::EntryKind,
    refs::{
        Target,
        transaction::{Change as RefChange, LogChange, PreviousValue, RefEdit, RefLog},
    },
    status::{UntrackedFiles, index_worktree::Item, tree_index::TrackRenames},
};

use crate::{branch::Branch, context::TransactionContext};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Head {
    Change(ChangeId),
    Detached(Revision),
}

impl Head {
    fn target(&self) -> Target {
        match self {
            Head::Change(id) => Target::Symbolic(id.branch_ref()),
            Head::Detached(revision) => Target::Object(revision.0),
        }
    }
}

/// A workspace as of one instant: where it is and what it has checked out. Its files are not
/// state of their own: they follow `head`, and are only ever written through a transaction.
#[derive(Clone)]
pub struct Workspace<'ctx> {
    ctx: &'ctx TransactionContext<'ctx>,
    id: WorkspaceId,
    path: PathBuf,
    pub head: Head,
}

impl fmt::Debug for Workspace<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Workspace").field("id", &self.id).field("path", &self.path).field("head", &self.head).finish()
    }
}

/// How a working directory and index differ from a tree.
#[derive(PartialEq, Eq)]
enum Status {
    Clean,
    /// Only files the tree does not have.
    Untracked,
    Modified,
}

impl<'ctx> Workspace<'ctx> {
    /// A workspace that does not exist yet, to be made at `path` by [`Self::create`].
    pub fn new(ctx: &'ctx TransactionContext<'ctx>, path: &Path, head: Head) -> Result<Self> {
        Ok(Self { ctx, id: WorkspaceId::linked_at(path)?, path: path.to_owned(), head })
    }

    pub fn load(ctx: &'ctx TransactionContext<'ctx>, id: WorkspaceIdRef<'_>) -> Result<Self> {
        let repo = open(&ctx.repo, id)?;
        let head = match repo.head_name()? {
            Some(name) => Head::Change(name.shorten().to_str()?.parse()?),
            None => Head::Detached(Revision(repo.head_id()?.detach())),
        };
        let path = repo.workdir().ok_or_else(|| format!("workspace {id} has no working directory"))?.to_owned();
        Ok(Self { ctx, id: id.into_owned(), path, head })
    }

    pub fn id(&self) -> WorkspaceIdRef<'_> { self.id.to_ref() }

    /// The change checked out here, or `None` when HEAD is detached.
    pub fn change(&self) -> Option<&ChangeId> {
        match &self.head {
            Head::Change(id) => Some(id),
            Head::Detached(_) => None,
        }
    }

    /// The working directory, which may be missing if it was moved or deleted outside git.
    pub fn path(&self) -> &Path { &self.path }

    /// The repository as seen from this workspace: its HEAD, index, and working directory.
    fn repo(&self) -> Result<Repository> { open(&self.ctx.repo, self.id()) }

    /// Make the working directory and git's record of it, then fill it with `tip`'s files, as
    /// `git worktree add` does.
    pub fn create(&self, tip: Revision) -> Result<()> {
        let WorkspaceIdRef::Linked(id) = self.id() else { Err("the main workspace cannot be added")? };
        let admin = self.ctx.repo.common_dir().join("worktrees").join(gix::path::from_bstr(id));
        if admin.exists() {
            Err(format!("workspace {id} already exists"))?;
        }
        fs::create_dir_all(&self.path)?;
        if self.path.read_dir()?.next().is_some() {
            Err(format!("{} is not empty", self.path.display()))?;
        }
        fs::create_dir_all(&admin)?;
        fs::write(admin.join("commondir"), "../..\n")?;
        fs::write(admin.join("gitdir"), format!("{}\n", self.path.join(".git").display()))?;
        let head = match &self.head {
            Head::Change(id) => format!("ref: {}\n", id.branch_ref().as_bstr()),
            Head::Detached(revision) => format!("{revision}\n"),
        };
        fs::write(admin.join("HEAD"), head)?;
        fs::write(self.path.join(".git"), format!("gitdir: {}\n", admin.display()))?;
        let repo = self.repo()?;
        self.write_files(&repo, &repo.empty_tree(), &repo.find_commit(tip)?.tree()?)
    }

    /// Check out `to` in place of `from`, the revision the files are at, and point HEAD at the
    /// head. Local changes are refused rather than carried over or lost.
    pub fn switch(&self, from: Revision, to: Revision) -> Result<()> {
        let repo = self.repo()?;
        let from = repo.find_commit(from)?.tree()?;
        if status(&repo, &from)? == Status::Modified {
            Err(format!("workspace {} has local changes", self.id))?;
        }
        self.write_files(&repo, &from, &repo.find_commit(to)?.tree()?)?;
        repo.edit_reference(RefEdit {
            change: RefChange::Update {
                log: LogChange {
                    mode: RefLog::AndReference,
                    force_create_reflog: false,
                    message: "cabaret: switch".into(),
                },
                expected: PreviousValue::Any,
                new: self.head.target(),
            },
            name: "HEAD".try_into()?,
            deref: false,
        })?;
        Ok(())
    }

    /// Delete the working directory and git's record of it, as `git worktree remove` does. Only
    /// a workspace holding nothing of its own goes: local changes and untracked files alike
    /// would be lost.
    pub fn delete(&self) -> Result<()> {
        if self.id == WorkspaceId::Main {
            Err("the main workspace cannot be removed")?;
        }
        let repo = self.repo()?;
        match status(&repo, &repo.head_commit()?.tree()?)? {
            Status::Modified => Err(format!("workspace {} has local changes", self.id))?,
            Status::Untracked => Err(format!("workspace {} has untracked files", self.id))?,
            Status::Clean => {}
        }
        fs::remove_dir_all(&self.path)?;
        fs::remove_dir_all(repo.git_dir())?;
        Ok(())
    }

    /// Move the files from `from` to `to`, touching only the paths that differ. A workspace that
    /// is not cleanly at `from` stays where it is. Takes `&mut self` to keep it to reserved
    /// workspaces; only the files change.
    pub fn fast_forward(&mut self, from: Revision, to: Revision) -> Result<()> {
        let repo = self.repo()?;
        let from = repo.find_commit(from)?.tree()?;
        if status(&repo, &from)? == Status::Modified {
            return Ok(());
        }
        self.write_files(&repo, &from, &repo.find_commit(to)?.tree()?)
    }

    /// The tree of what is on disk at the paths `pathspecs` match, all when empty, laid over
    /// HEAD's tree; and an index at that tree. Whatever the index holds beyond HEAD counts as on
    /// disk too, since git tools stage there. Beyond that the index is only a stat cache of the
    /// working directory, so refreshing it here is not sequenced with the other workspace writes.
    /// Takes `&mut self` to keep it to reserved workspaces.
    pub fn snapshot(&mut self, pathspecs: &[Pathspec]) -> Result<TreeId> {
        let repo = self.repo()?;
        let workdir = repo.workdir().expect("workspaces have working directories");
        let head = repo.head_tree_id()?.detach();
        let old = repo.index_or_empty()?;
        let executable_bit = repo.filesystem_options()?.executable_bit;
        let (mut filters, attributes) = repo.filter_pipeline(None)?;
        let mut editor = repo.edit_tree(head)?;
        let patterns = || pathspecs.iter().map(|spec| spec.0.to_bstring());

        let mut pathspec =
            gix::Pathspec::new(
                &repo,
                false,
                patterns(),
                false,
                || Err("attribute pathspecs are not supported".into()),
            )?;
        repo.tree_index_status(&head, &old, Some(&mut pathspec), TrackRenames::Disabled, |change, _, _| {
            use gix::diff::index::ChangeRef::{Addition, Deletion, Modification, Rewrite};
            match change {
                Addition { location, entry_mode, id, .. } | Modification { location, entry_mode, id, .. } => {
                    let mode = entry_mode.to_tree_entry_mode().ok_or_else(|| format!("{location} has no tree mode"))?;
                    editor.upsert(location.as_ref(), mode.kind(), id.into_owned())?;
                }
                Deletion { location, .. } => {
                    editor.remove(location.as_ref())?;
                }
                Rewrite { .. } => unreachable!("rewrite tracking is disabled"),
            }
            Ok::<_, Box<dyn std::error::Error + Send + Sync>>(ControlFlow::Continue(()))
        })?;

        // Each changed path gets whatever is on disk there now, so a removal and a file gone
        // since the walk read the same.
        let mut hashed = BTreeSet::new();
        for path in changed_paths(&repo, patterns())? {
            let disk = workdir.join(gix::path::from_bstr(path.as_bstr()));
            let metadata = match disk.symlink_metadata() {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    editor.remove(path.as_bstr())?;
                    continue;
                }
                Err(error) => Err(error)?,
            };
            let file_type = metadata.file_type();
            // TODO-someday(joel): symlinks on a filesystem without them are committed as files
            let (kind, blob) = if file_type.is_symlink() {
                let target = gix::path::into_bstr(fs::read_link(&disk)?);
                (EntryKind::Link, repo.write_blob(target.as_ref())?)
            } else if file_type.is_file() {
                let content = filters.convert_to_git(
                    fs::File::open(&disk)?,
                    &gix::path::from_bstr(path.as_bstr()),
                    &attributes,
                )?;
                let kind = match executable_bit && gix::fs::is_executable(&metadata) {
                    true => EntryKind::BlobExecutable,
                    false => EntryKind::Blob,
                };
                (kind, repo.write_blob_stream(content)?)
            } else if file_type.is_dir() {
                // a directory took the file's place; the walk emits the files within it
                editor.remove(path.as_bstr())?;
                continue;
            } else {
                Err(format!("{path} is not a file, symlink, or directory"))?
            };
            editor.upsert(path.as_bstr(), kind, blob)?;
            hashed.insert(path);
        }
        let tree = TreeId(editor.write()?.detach());

        let mut index = repo.index_from_tree(&tree.0)?;
        for (entry, path) in index.entries_mut_with_paths() {
            entry.stat = match hashed.contains(path) {
                true => {
                    let disk = workdir.join(gix::path::from_bstr(path));
                    Stat::from_fs(&gix::index::fs::Metadata::from_path_no_follow(&disk)?)?
                }
                false => match old.entry_by_path(path) {
                    Some(previous) if previous.id == entry.id => previous.stat,
                    _ => Stat::default(),
                },
            };
        }
        index.write(gix::index::write::Options::default())?;
        Ok(tree)
    }

    /// Write the paths that differ between `from`, which the files are at, and `to`, and an
    /// index at `to`.
    // TODO(joel): untracked files at paths `to` adds are overwritten; refuse or merge instead
    fn write_files(&self, repo: &Repository, from: &Tree<'_>, to: &Tree<'_>) -> Result<()> {
        let workdir = repo.workdir().expect("workspaces have working directories");

        // gix checks out a whole index, so the files to write get one of their own.
        let mut written = gix::index::State::new(repo.object_hash());
        for change in repo.diff_tree_to_tree(from, to, gix::diff::Options::default().with_rewrites(None))? {
            use gix::diff::tree_with_rewrites::Change::{Addition, Deletion, Modification, Rewrite};
            if change.entry_mode().is_tree() {
                continue;
            }
            if let Deletion { location, .. } | Modification { location, .. } = &change {
                let path = workdir.join(gix::path::from_bstr(location));
                fs::remove_file(&path)?;
                prune_empty_dirs(workdir, path.parent().expect("workspace files have a parent"));
            }
            if let Addition { location, entry_mode, id, .. } | Modification { location, entry_mode, id, .. } = &change {
                written.dangerously_push_entry(
                    Stat::default(),
                    *id,
                    Flags::empty(),
                    (*entry_mode).into(),
                    location.as_bstr(),
                );
            }
            if let Rewrite { .. } = change {
                unreachable!("rewrite tracking is disabled");
            }
        }
        written.sort_entries();
        let outcome = gix::worktree::state::checkout(
            &mut written,
            workdir,
            repo.objects.clone().into_arc()?,
            &gix::progress::Discard,
            &gix::progress::Discard,
            &gix::interrupt::IS_INTERRUPTED,
            repo.checkout_options(gix::worktree::stack::state::attributes::Source::IdMappingThenWorktree)?,
        )?;
        if let Some(collision) = outcome.collisions.first() {
            Err(format!("{} is in the way in workspace {}", collision.path, self.id))?;
        }

        // Stat data lets status trust unchanged files instead of rehashing them.
        let old = repo.index_or_empty()?;
        let mut index = repo.index_from_tree(&to.id)?;
        for (entry, path) in index.entries_mut_with_paths() {
            let source = written.entry_by_path(path).or_else(|| old.entry_by_path(path));
            entry.stat = source.expect("every path in `to` was just written or is unchanged from `from`").stat;
        }
        index.write(gix::index::write::Options::default())?;
        Ok(())
    }
}

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

    /// The workspace this transaction's repository was opened in.
    pub fn current_workspace(&self) -> Result<WorkspaceId> {
        let worktree = self.repo.worktree().ok_or("not opened inside a workspace")?;
        Ok(match worktree.id() {
            None => WorkspaceId::Main,
            Some(id) => WorkspaceId::Linked(id.to_owned()),
        })
    }
}

/// The repository as seen from `workspace`: its HEAD, index, and working directory. Only a
/// [`Workspace`] holds one, so files are touched only through a reserved workspace.
fn open(repo: &Repository, workspace: WorkspaceIdRef<'_>) -> Result<Repository> {
    match workspace {
        WorkspaceIdRef::Main => Ok(repo.main_repo()?),
        WorkspaceIdRef::Linked(id) => {
            let proxy = repo.worktree_proxy_by_id(id).ok_or_else(|| format!("no workspace {id}"))?;
            Ok(proxy.into_repo_with_possibly_inaccessible_worktree()?)
        }
    }
}

/// The paths at which the working directory differs from the index, within `patterns`.
fn changed_paths(repo: &Repository, patterns: impl IntoIterator<Item = BString>) -> Result<Vec<BString>> {
    use gix::{
        dir::entry::{Kind, Status},
        status::plumbing::index_as_worktree::{Change, EntryStatus},
    };
    let items = repo
        .status(gix::progress::Discard)?
        .untracked_files(UntrackedFiles::Files)
        .index_worktree_rewrites(None)
        .into_index_worktree_iter(patterns)?;
    let mut paths = Vec::new();
    for item in items {
        match item? {
            Item::Modification { rela_path, status, .. } => match status {
                EntryStatus::NeedsUpdate(_) => {}
                EntryStatus::Conflict { .. } => Err(format!("{rela_path} is conflicted in the index"))?,
                EntryStatus::Change(Change::SubmoduleModification(_)) => {
                    Err(format!("{rela_path} is a submodule, which is not supported"))?;
                }
                EntryStatus::Change(Change::Removed | Change::Type { .. } | Change::Modification { .. })
                | EntryStatus::IntentToAdd => paths.push(rela_path),
            },
            // TODO-someday(joel): nested repositories are skipped, where git would embed them
            Item::DirectoryContents { entry, .. } => match (entry.status, entry.disk_kind) {
                (Status::Untracked, Some(Kind::File | Kind::Symlink)) => paths.push(entry.rela_path),
                _ => {}
            },
            Item::Rewrite { .. } => unreachable!("rewrite tracking is disabled"),
        }
    }
    Ok(paths)
}

/// How `repo`'s index and working directory differ from `tree`.
fn status(repo: &Repository, tree: &Tree<'_>) -> Result<Status> {
    let mut index_matches = true;
    repo.tree_index_status(&tree.id, &*repo.index_or_empty()?, None, TrackRenames::Disabled, |_, _, _| {
        index_matches = false;
        Ok::<_, Infallible>(ControlFlow::Break(()))
    })?;
    if !index_matches {
        return Ok(Status::Modified);
    }
    let mut untracked = false;
    let items = repo
        .status(gix::progress::Discard)?
        .index_worktree_rewrites(None)
        .index_worktree_submodules(gix::status::Submodule::AsConfigured { check_dirty: true })
        .into_index_worktree_iter(Vec::new())?;
    for item in items {
        match item? {
            Item::DirectoryContents { entry, .. } if entry.status == gix::dir::entry::Status::Untracked => {
                untracked = true;
            }
            _ => return Ok(Status::Modified),
        }
    }
    Ok(if untracked { Status::Untracked } else { Status::Clean })
}

fn prune_empty_dirs(workdir: &Path, mut dir: &Path) {
    while dir != workdir && fs::remove_dir(dir).is_ok() {
        dir = dir.parent().expect("pruning stops at the workspace root");
    }
}

impl Branch<'_> {
    /// The workspace with this change checked out, if any.
    pub fn workspace(&self) -> Result<Option<WorkspaceId>> {
        let ctx = self.ctx();
        for workspace in ctx.workspaces()? {
            if ctx.workspace(workspace.to_ref())?.change().is_some_and(|change| **change == *self.id()) {
                return Ok(Some(workspace));
            }
        }
        Ok(None)
    }
}

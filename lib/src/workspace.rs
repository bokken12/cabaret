//! Workspaces: the working directories of the repository, each holding at most one checked-out
//! change. Git refuses to check one branch out twice, so a change has at most one workspace.
//! When a change's branch moves, its workspace must move with it, or git would show the whole
//! change as undone locally.

use std::{convert::Infallible, fs, ops::ControlFlow, path::Path};

use gix::{
    Repository,
    bstr::ByteSlice,
    index::entry::{Flags, Stat},
    status::tree_index::TrackRenames,
};

use crate::{
    branch::Branch,
    context::TransactionContext,
    error::Result,
    types::{ChangeId, Revision, WorkspaceId, WorkspaceIdRef},
};

#[derive(Clone, Debug)]
pub enum Head {
    Change(ChangeId),
    Detached(Revision),
}

// TODO(joel): fill out
#[derive(Clone, Debug)]
pub struct Workspace<'ctx> {
    ctx: &'ctx TransactionContext<'ctx>,
    id: WorkspaceId,
    pub head: Head,
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

    /// The repository as seen from `workspace`: its HEAD, index, and working directory. The
    /// directory itself may be missing if the worktree was moved or deleted outside git.
    pub fn workspace_repo(&self, workspace: WorkspaceIdRef<'_>) -> Result<Repository> {
        match workspace {
            WorkspaceIdRef::Main => Ok(self.repo.main_repo()?),
            WorkspaceIdRef::Linked(id) => {
                let proxy = self.repo.worktree_proxy_by_id(id).ok_or_else(|| format!("no workspace {id}"))?;
                Ok(proxy.into_repo_with_possibly_inaccessible_worktree()?)
            }
        }
    }

    /// Move `workspace` from `from` to `to`, touching only the paths that differ. A workspace
    /// that is not cleanly at `from` stays where it is.
    // TODO(joel): untracked files at paths `to` adds are overwritten; refuse or merge instead
    pub fn fast_forward(&self, workspace: WorkspaceIdRef<'_>, from: Revision, to: Revision) -> Result<()> {
        let repo = self.workspace_repo(workspace)?;
        let from = repo.find_commit(from)?.tree()?;
        let to = repo.find_commit(to)?.tree()?;
        if !is_at(&repo, &from)? {
            return Ok(());
        }
        let workdir = repo.workdir().expect("workspaces have working directories");

        // gix checks out a whole index, so the files to write get one of their own.
        let mut written = gix::index::State::new(repo.object_hash());
        for change in repo.diff_tree_to_tree(&from, &to, gix::diff::Options::default().with_rewrites(None))? {
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
            Err(format!("{} is in the way in workspace {workspace}", collision.path))?;
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

    /// The change checked out in `workspace`, or `None` when its HEAD is detached.
    pub fn workspace_change(&self, workspace: WorkspaceIdRef<'_>) -> Result<Option<ChangeId>> {
        match self.workspace_repo(workspace)?.head_name()? {
            Some(head) => Ok(Some(head.shorten().to_str()?.parse()?)),
            None => Ok(None),
        }
    }
}

/// Whether `repo`'s index and working directory match `tree`, untracked files aside.
fn is_at(repo: &Repository, tree: &gix::Tree<'_>) -> Result<bool> {
    let mut index_matches = true;
    repo.tree_index_status(&tree.id, &*repo.index_or_empty()?, None, TrackRenames::Disabled, |_, _, _| {
        index_matches = false;
        Ok::<_, Infallible>(ControlFlow::Break(()))
    })?;
    if !index_matches {
        return Ok(false);
    }
    let mut worktree_changes = repo
        .status(gix::progress::Discard)?
        .index_worktree_rewrites(None)
        .index_worktree_submodules(gix::status::Submodule::AsConfigured { check_dirty: true })
        .index_worktree_options_mut(|opts| opts.dirwalk_options = None)
        .into_index_worktree_iter(Vec::new())?;
    Ok(worktree_changes.next().transpose()?.is_none())
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
            if ctx.workspace_change(workspace.to_ref())?.as_deref() == Some(self.id()) {
                return Ok(Some(workspace));
            }
        }
        Ok(None)
    }
}

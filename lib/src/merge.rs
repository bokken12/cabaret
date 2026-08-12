use std::{
    collections::BTreeSet,
    fs,
    num::NonZeroU8,
    path::{Path, PathBuf},
};

use gix::{
    ObjectId,
    bstr::{BString, ByteSlice},
    merge::blob::builtin_driver::text::{Conflict, ConflictStyle, Labels},
    refs::FullName,
};

use crate::{cabaret::Cabaret, error::Result, types::ChangeId};

/// A merge computed but not yet committed; drop it to abandon the merge.
#[derive(Debug)]
pub struct PreparedMerge {
    branch: FullName,
    /// The current workdir when it has `branch` checked out and must be updated after committing.
    worktree: Option<PathBuf>,
    into_tip: ObjectId,
    from_tip: ObjectId,
    tree: ObjectId,
    conflicts: Vec<String>,
}

impl PreparedMerge {
    /// Paths whose merge conflicted; committing writes them with conflict markers.
    pub fn conflicts(&self) -> &[String] { &self.conflicts }
}

impl Cabaret {
    /// Compute the merge of `from`'s tip into `into`'s branch without committing it, or `None`
    /// when `into` already contains `from`.
    pub fn prepare_merge(&self, into: &ChangeId, from: &ChangeId) -> Result<Option<PreparedMerge>> {
        let into_tip = self.tip(into)?;
        let from_tip = self.tip(from)?;
        if self.repo.merge_base(into_tip, from_tip)? == from_tip {
            return Ok(None);
        }

        let branch = into.branch_ref();
        let checked_out = self.repo.head_name()?.is_some_and(|head| head == branch);
        let worktree = if checked_out {
            self.repo.workdir().map(Path::to_owned)
        } else {
            // Never move the branch under another workspace: its index and files would be left
            // describing the old tip, and this merge cannot see whether it is even clean.
            if let Some(workspace) = self.workspace_holding(&branch)? {
                return Err(format!(
                    "{into} is checked out in workspace {}; rerun from that workspace",
                    workspace.workdir().expect("held branches have a workdir").display()
                )
                .into());
            }
            None
        };
        if worktree.is_some() && self.repo.is_dirty()? {
            return Err("working tree has uncommitted changes".into());
        }

        // Uncommitted work in `from`'s workspace would be silently absent from the merge.
        if let Some(workspace) = self.workspace_holding(&from.branch_ref())?
            && workspace.is_dirty()?
        {
            return Err(format!(
                "{from} has uncommitted changes in workspace {}",
                workspace.workdir().expect("held branches have a workdir").display()
            )
            .into());
        }

        let labels =
            Labels { ancestor: Some("base".into()), current: Some(into.as_bstr()), other: Some(from.as_bstr()) };
        let options = self.merge_options(default_marker_size())?;
        let mut merge = self.repo.merge_commits(into_tip, from_tip, labels, options.into())?;
        let tree = merge.tree_merge.tree.write()?.detach();
        let conflicts = unresolved_paths(&merge.tree_merge);

        Ok(Some(PreparedMerge { branch, worktree, into_tip, from_tip, tree, conflicts }))
    }

    /// Commit a prepared merge to its branch and refresh the checkout that holds it, if any.
    pub fn commit_merge(&self, merge: PreparedMerge, message: String) -> Result<()> {
        self.repo.commit(merge.branch, message, merge.tree, [merge.into_tip, merge.from_tip])?;
        if let Some(workdir) = merge.worktree {
            self.checkout(&workdir, merge.tree)?;
        }
        Ok(())
    }

    /// The workspace repository that has `branch` checked out, if any.
    fn workspace_holding(&self, branch: &FullName) -> Result<Option<gix::Repository>> {
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

    pub(crate) fn tip(&self, change: &ChangeId) -> Result<ObjectId> {
        Ok(self.repo.find_reference(&change.branch_ref())?.peel_to_commit()?.id)
    }

    /// Conflict style and rename detection are forced rather than read from config so the
    /// committed conflict text is identical no matter whose clone performs the merge.
    pub(crate) fn merge_options(&self, marker_size: NonZeroU8) -> Result<gix::merge::tree::Options> {
        let mut options: gix::merge::plumbing::tree::Options = self.repo.tree_merge_options()?.into();
        options.rewrites = Some(gix::diff::Rewrites::default());
        options.blob_merge.text.conflict = Conflict::Keep { style: ConflictStyle::ZealousDiff3, marker_size };
        Ok(options.into())
    }

    /// Make the (clean) worktree and index match `tree`.
    // TODO-someday(joel): apply only the delta between the old and new trees; rewriting every
    // file on each merge won't fly in a large repository.
    fn checkout(&self, workdir: &Path, tree: ObjectId) -> Result<()> {
        let mut index = self.repo.index_from_tree(&tree)?;

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
}

pub(crate) fn default_marker_size() -> NonZeroU8 {
    Conflict::DEFAULT_MARKER_SIZE.try_into().expect("the default marker size is non-zero")
}

/// Paths the merge left unresolved, sorted and deduplicated.
pub(crate) fn unresolved_paths(merge: &gix::merge::tree::Outcome<'_>) -> Vec<String> {
    let unresolved = gix::merge::tree::TreatAsUnresolved::default();
    let mut paths: Vec<String> = merge
        .conflicts
        .iter()
        .filter(|conflict| conflict.is_unresolved(unresolved))
        .map(|conflict| conflict.changes_in_resolution().0.location().to_string())
        .collect();
    paths.sort();
    paths.dedup();
    paths
}

fn prune_empty_dirs(workdir: &Path, mut dir: &Path) {
    while dir != workdir && fs::remove_dir(dir).is_ok() {
        dir = dir.parent().expect("pruning stops at the worktree root");
    }
}

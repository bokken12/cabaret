use std::{collections::BTreeSet, fs, num::NonZeroU8, path::Path};

use gix::{
    Repository,
    bstr::{BString, ByteSlice},
    merge::blob::builtin_driver::text::{Conflict, ConflictStyle, Labels},
    refs::FullName,
};

use crate::{
    cabaret::Cabaret,
    error::Result,
    types::{ChangeId, Liveness, Revision, TreeId},
};

/// A merge computed but not yet committed; drop it to abandon the merge.
#[derive(Debug)]
pub struct PreparedMerge {
    branch: FullName,
    /// The workspace holding `branch`, whose checkout the commit must refresh.
    workspace: Option<Repository>,
    into_tip: Revision,
    from_tip: Revision,
    tree: TreeId,
    conflicts: Vec<String>,
}

impl PreparedMerge {
    /// Paths whose merge conflicted; committing writes them with conflict markers.
    pub fn conflicts(&self) -> &[String] { &self.conflicts }
}

impl Cabaret {
    // Returns conflicts
    pub fn rebase(&self, change: &ChangeId, onto: &ChangeId) -> Result<Option<Vec<String>>> {
        if !self.log(change)?.parents.contains(onto) {
            return Err(format!("{onto} is not a parent of {change}").into());
        }
        match self.prepare_merge(change, onto)? {
            None => Ok(None),
            Some(merge) => {
                let conflicts = merge.conflicts().to_vec();
                self.commit_merge(merge, format!("rebase {change} onto {onto}"))?;
                Ok(Some(conflicts))
            }
        }
    }

    // TODO(joel): derived parents
    pub fn land(&self, id: &ChangeId) -> Result<()> {
        let log = self.log(id)?;

        let do_archive = match log.liveness {
            Liveness::Archived => return Err(format!("{id} is archived").into()),
            Liveness::Live => true,
            Liveness::Permanent => false,
        };

        let parents: Vec<&ChangeId> = log.parents.iter().collect();
        let parent = match parents.as_slice() {
            [] => return Err(format!("{id} has no parents").into()),
            [parent] => parent,
            [_, _, ..] => return Err(format!("{id} has multiple parents; cannot land").into()),
        };

        match self.prepare_merge(parent, id)? {
            None => Err(format!("{id} has nothing to land").into()),
            Some(merge) => match merge.conflicts() {
                [_, ..] => Err(format!("{id} conflicts with {parent}; rebase and resolve first").into()),
                [] => {
                    if do_archive {
                        self.set_liveness(id, Liveness::Archived)?;
                        // TODO(joel): reparent children
                    }
                    self.commit_merge(merge, format!("land {id} into {parent}"))?;
                    Ok(())
                }
            },
        }
    }

    /// Compute the merge of `from`'s tip into `into`'s branch without committing it, or `None`
    /// when `into` already contains `from`.
    pub fn prepare_merge(&self, into: &ChangeId, from: &ChangeId) -> Result<Option<PreparedMerge>> {
        let into_tip = self.tip(into)?;
        let from_tip = self.tip(from)?;
        if self.repo.merge_base(into_tip, from_tip)? == from_tip.0 {
            return Ok(None);
        }

        // Uncommitted work would be clobbered by `into`'s refresh or silently absent from
        // `from`'s tip, so a dirty workspace on either side refuses the merge.
        let workspace = self.clean_workspace_holding(into)?;
        self.clean_workspace_holding(from)?;

        let labels =
            Labels { ancestor: Some("base".into()), current: Some(into.as_bstr()), other: Some(from.as_bstr()) };
        let options = self.merge_options(default_marker_size())?;
        let mut merge = self.repo.merge_commits(into_tip, from_tip, labels, options.into())?;
        let tree = TreeId(merge.tree_merge.tree.write()?.detach());
        let conflicts = unresolved_paths(&merge.tree_merge);

        Ok(Some(PreparedMerge { branch: into.branch_ref(), workspace, into_tip, from_tip, tree, conflicts }))
    }

    /// Commit a prepared merge to its branch and refresh the checkout that holds it, if any.
    pub fn commit_merge(&self, merge: PreparedMerge, message: String) -> Result<()> {
        self.repo.commit(merge.branch, message, merge.tree, [merge.into_tip, merge.from_tip])?;
        if let Some(workspace) = merge.workspace {
            checkout(&workspace, merge.tree)?;
        }
        Ok(())
    }

    /// The workspace holding `change`'s branch, if any, refusing when it has uncommitted changes.
    fn clean_workspace_holding(&self, change: &ChangeId) -> Result<Option<Repository>> {
        let Some(workspace) = self.workspace_holding(&change.branch_ref())? else {
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

    pub fn tip(&self, change: &ChangeId) -> Result<Revision> {
        Ok(Revision(self.repo.find_reference(&change.branch_ref())?.peel_to_commit()?.id))
    }

    /// Conflict style and rename detection are forced rather than read from config so the
    /// committed conflict text is identical no matter whose clone performs the merge.
    pub fn merge_options(&self, marker_size: NonZeroU8) -> Result<gix::merge::tree::Options> {
        let mut options: gix::merge::plumbing::tree::Options = self.repo.tree_merge_options()?.into();
        options.rewrites = Some(gix::diff::Rewrites::default());
        options.blob_merge.text.conflict = Conflict::Keep { style: ConflictStyle::ZealousDiff3, marker_size };
        Ok(options.into())
    }
}

/// Make the (clean) worktree and index of `repo`'s workspace match `tree`.
// TODO-someday(joel): apply only the delta between the old and new trees; rewriting every
// file on each merge won't fly in a large repository.
pub fn checkout(repo: &Repository, tree: TreeId) -> Result<()> {
    let workdir = repo.workdir().ok_or("workspace has no working directory")?;
    let mut index = repo.index_from_tree(&tree.0)?;

    let old = repo.open_index()?;
    let keep: BTreeSet<BString> = index.entries().iter().map(|entry| entry.path(&index).to_owned()).collect();
    for entry in old.entries() {
        let path = entry.path(&old);
        if !keep.contains(path.as_bstr()) {
            let path = workdir.join(gix::path::from_bstr(path));
            fs::remove_file(&path)?;
            prune_empty_dirs(workdir, path.parent().expect("worktree files have a parent"));
        }
    }

    let mut options = repo.checkout_options(gix::worktree::stack::state::attributes::Source::IdMapping)?;
    options.overwrite_existing = true;
    gix::worktree::state::checkout(
        &mut index,
        workdir,
        repo.objects.clone().into_arc()?,
        &gix::progress::Discard,
        &gix::progress::Discard,
        &gix::interrupt::IS_INTERRUPTED,
        options,
    )?;
    index.write(gix::index::write::Options::default())?;
    Ok(())
}

pub fn default_marker_size() -> NonZeroU8 {
    Conflict::DEFAULT_MARKER_SIZE.try_into().expect("the default marker size is non-zero")
}

/// Paths the merge left unresolved, sorted and deduplicated.
pub fn unresolved_paths(merge: &gix::merge::tree::Outcome<'_>) -> Vec<String> {
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

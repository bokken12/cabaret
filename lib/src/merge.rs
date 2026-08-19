use std::num::NonZeroU8;

use gix::{
    Repository,
    merge::blob::builtin_driver::text::{Conflict, ConflictStyle, Labels},
};

use crate::{
    cabaret::Cabaret,
    change::ChangeId,
    error::Result,
    revision::Revision,
    types::{Liveness, TreeId},
};

/// A merge computed but not yet committed; drop it to abandon the merge.
#[derive(Debug)]
pub struct PreparedMerge {
    change: ChangeId,
    /// The workspace holding `branch`, whose checkout the commit must refresh.
    workspace: Option<Repository>,
    into_tip: Revision,
    from_tip: Revision,
    tree: TreeId,
    conflicts: Vec<gix::merge::tree::Conflict>,
}

pub fn default_marker_size() -> NonZeroU8 {
    Conflict::DEFAULT_MARKER_SIZE.try_into().expect("the default marker size is non-zero")
}

impl Cabaret {
    /// Conflict style and rename detection are forced rather than read from config so the
    /// committed conflict text is identical no matter whose clone performs the merge.
    pub fn merge_options(&self, marker_size: NonZeroU8) -> Result<gix::merge::tree::Options> {
        let mut options: gix::merge::plumbing::tree::Options = self.repo.tree_merge_options()?.into();
        options.rewrites = Some(gix::diff::Rewrites::default());
        options.blob_merge.text.conflict = Conflict::Keep { style: ConflictStyle::ZealousDiff3, marker_size };
        Ok(options.into())
    }

    /// Compute the merge of `from`'s tip into `into`'s branch without committing it, or `None`
    /// when `into` already contains `from`.
    pub fn prepare_merge(&self, into: &ChangeId, from: &ChangeId) -> Result<Option<PreparedMerge>> {
        let into_tip = self.tip(into)?;
        let from_tip = self.tip(from)?;
        if self.repo.merge_base(into_tip, from_tip)? == from_tip.0 {
            return Ok(None);
        }

        let workspace = self.workspace_holding(into)?.map(|workspace| self.workspace_repo(&workspace)).transpose()?;

        let labels =
            Labels { ancestor: Some("base".into()), current: Some(into.as_bstr()), other: Some(from.as_bstr()) };
        let options = self.merge_options(default_marker_size())?;
        let mut merge = self.repo.merge_commits(into_tip, from_tip, labels, options.into())?;
        let tree = TreeId(merge.tree_merge.tree.write()?.detach());
        let conflicts = merge.tree_merge.conflicts;

        Ok(Some(PreparedMerge { change: into.clone(), workspace, into_tip, from_tip, tree, conflicts }))
    }

    /// Commit a prepared merge to its branch and refresh the checkout that holds it, if any.
    pub fn commit_merge(&self, merge: PreparedMerge, message: String) -> Result<()> {
        self.repo.commit(merge.change.branch_ref(), message, merge.tree, [merge.into_tip, merge.from_tip])?;
        if let Some(workspace) = merge.workspace {
            let cabaret = Cabaret { repo: workspace };
            cabaret.checkout(merge.tree)?;
        }
        Ok(())
    }

    // Returns conflicts
    pub fn rebase(&self, change: &ChangeId, onto: &ChangeId) -> Result<()> {
        if !self.parents(change)?.contains(onto) {
            return Err(format!("{onto} is not a parent of {change}").into());
        }
        match self.prepare_merge(change, onto)? {
            None => Ok(()),
            Some(merge) => self.commit_merge(merge, format!("rebase {change} onto {onto}")),
        }
    }

    // TODO(joel): derived parents
    pub fn land(&self, change: &ChangeId) -> Result<()> {
        if self.is_archived(change)? {
            return Err(format!("{change} is archived").into());
        }

        let Some(parent) = self.land_into(change)? else {
            return Err(format!("{change} must have exactly 1 parent to land").into());
        };

        let Some(merge) = self.prepare_merge(&parent, change)? else {
            return Err(format!("{change} has nothing to land").into());
        };

        if !merge.conflicts.is_empty() {
            return Err(format!("{change} conflicts with {parent}; rebase and resolve first").into());
        };

        if !self.is_permanent(change)? {
            self.set_liveness(change, Liveness::Archived)?;
            // TODO(joel): reparent children
        }
        self.commit_merge(merge, format!("land {change} into {parent}"))?;
        Ok(())
    }
}

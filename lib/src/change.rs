use std::collections::BTreeSet;

use crate::{
    change_id::{ChangeId, ChangeIdRef},
    context::TransactionContext,
    error::Result,
    revision::Revision,
    types::Identity,
};

// TODO(joel): move
// #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Change<'ctx> {
    ctx: &'ctx TransactionContext<'ctx>,
    id: ChangeId,
    tip: Revision,
    pub title: String,
    pub description: String,
    pub archived: bool,
    pub permanent: bool,
    pub owners: BTreeSet<Identity>,
    pub parents: BTreeSet<ChangeId>,
}

impl<'ctx> Change<'ctx> {
    pub fn is_descendant(&self, ancestor: &ChangeIdRef) -> Result<bool> {
        if ancestor == self.id.as_ref() {
            return Ok(true);
        }
        self.parents.iter().try_fold(false, |acc, parent| Ok(acc || self.ctx.read(parent)?.is_descendant(ancestor)?))
    }

    pub fn is_ancestor(&self, descendant: &ChangeIdRef) -> Result<bool> {
        Ok(self.ctx.read(descendant)?.is_descendant(&self.id)?)
    }

    pub fn parents(&self) -> Result<BTreeSet<ChangeId>> {
        // skip archived changes and target their parents directly.
        // skip dominators since their children will release into them.
        todo!()
    }

    /// No bases ==> change is a root (no parents)
    /// Multiple bases ==> base is the merge of the revisions
    pub fn bases(&self) -> Result<BTreeSet<Revision>> {
        let mut candidates = BTreeSet::new();

        // add merge bases for all parents
        for parent_id in self.parents()? {
            candidates.insert(self.ctx.merge_base(self.tip, self.ctx.read(&parent_id)?.tip)?);
        }

        self.ctx.maximal_revisions(&candidates)
    }
}

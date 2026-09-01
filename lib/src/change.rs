use std::collections::{BTreeMap, BTreeSet};

use crate::{
    context::TransactionContext,
    error::Result,
    types::{ChangeId, ChangeIdRef, Identity, RepoPath, Revision, RevisionRange},
};

#[derive(Clone, Debug)]
pub struct Change<'ctx> {
    ctx: &'ctx TransactionContext<'ctx>,
    id: ChangeId,
    pub tip: Revision,
    pub title: Option<String>,
    pub description: Option<String>,
    pub archived: bool,
    pub permanent: bool,
    pub owners: BTreeSet<Identity>,
    pub parents: BTreeSet<ChangeId>,
    pub review: BTreeMap<Identity, BTreeMap<RepoPath, RevisionRange>>,
}

impl<'ctx> Change<'ctx> {
    pub fn new(ctx: &'ctx TransactionContext<'ctx>, id: ChangeId, tip: Revision) -> Self {
        Self {
            ctx,
            id,
            tip,
            title: None,
            description: None,
            archived: false,
            permanent: false,
            owners: BTreeSet::new(),
            parents: BTreeSet::new(),
            review: BTreeMap::new(),
        }
    }

    pub fn id(&self) -> &ChangeIdRef { &self.id }

    pub fn tip(&self) -> Revision { self.tip }

    pub fn is_descendant(&self, ancestor: &ChangeIdRef) -> Result<bool> {
        if ancestor == self.id.as_ref() {
            return Ok(true);
        }
        self.parents.iter().try_fold(false, |acc, parent| Ok(acc || self.ctx.read(parent)?.is_descendant(ancestor)?))
    }

    pub fn is_ancestor(&self, descendant: &ChangeIdRef) -> Result<bool> {
        Ok(self.ctx.read(descendant)?.is_descendant(&self.id)?)
    }

    // TODO-someday(joel): store computed parents?
    pub fn parents(&self) -> Result<BTreeSet<ChangeId>> {
        if self.archived {
            return Ok(self.parents.clone());
        }

        let mut candidates = BTreeSet::new();
        let mut frontier: Vec<_> = self.parents.iter().cloned().collect();
        loop {
            let Some(candidate_id) = frontier.pop() else { break };
            let candidate = self.ctx.read(&candidate_id)?;

            // skip archived parents and land into their parents
            match candidate.archived {
                false => {
                    candidates.insert(candidate_id);
                }
                true => frontier.extend(candidate.parents.iter().cloned()),
            }
        }
        self.ctx.maximal_changes(&candidates)
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

impl<'ctx> TransactionContext<'ctx> {
    pub fn maximal_changes(&'ctx self, changes: &BTreeSet<ChangeId>) -> Result<BTreeSet<ChangeId>> {
        let mut candidates = changes.clone();

        for candidate_id in changes.iter() {
            let candidate = self.read(candidate_id)?;
            for other in candidates.iter() {
                if candidate_id != other && candidate.is_ancestor(other)? {
                    candidates.remove(candidate_id);
                    break;
                }
            }
        }

        Ok(candidates)
    }
}

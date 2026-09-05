//! What Cabaret knows about a change beyond where its branch points. Stored as a log behind a
//! ref, see [`crate::log`], which is a fact about storage rather than about the metadata.

use std::collections::{BTreeMap, BTreeSet};

use gix::ObjectId;

use crate::{
    error::Result,
    transaction::context::TransactionContext,
    types::{ChangeId, ChangeIdRef, Identity, RepoPath, RevisionRange},
};

/// A change's metadata as of one instant: everything about it except where its branch points.
#[derive(Clone, Debug)]
pub struct Metadata<'ctx> {
    ctx: &'ctx TransactionContext<'ctx>,
    id: ChangeId,
    log_commit: Option<ObjectId>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub archived: bool,
    pub permanent: bool,
    pub owners: BTreeSet<Identity>,
    pub declared_parents: BTreeSet<ChangeId>,
    pub review: BTreeMap<Identity, BTreeMap<RepoPath, RevisionRange>>,
}

impl<'ctx> Metadata<'ctx> {
    /// Empty metadata, as folded from `log_commit` before any entries are applied.
    pub(crate) fn new(ctx: &'ctx TransactionContext<'ctx>, id: ChangeId, log_commit: Option<ObjectId>) -> Self {
        Self {
            ctx,
            id,
            log_commit,
            title: None,
            description: None,
            archived: false,
            permanent: false,
            owners: BTreeSet::new(),
            declared_parents: BTreeSet::new(),
            review: BTreeMap::new(),
        }
    }

    pub fn ctx(&self) -> &'ctx TransactionContext<'ctx> { self.ctx }

    pub fn id(&self) -> &ChangeIdRef { &self.id }

    /// The log commit this state was folded from; `None` before the change's first write.
    pub fn log_commit(&self) -> Option<ObjectId> { self.log_commit }

    pub fn is_descendant(&self, ancestor: &ChangeIdRef) -> Result<bool> {
        if ancestor == self.id.as_ref() {
            return Ok(true);
        }
        self.declared_parents
            .iter()
            .try_fold(false, |acc, parent| Ok(acc || self.ctx.metadata(parent)?.is_descendant(ancestor)?))
    }

    pub fn is_ancestor(&self, descendant: &ChangeIdRef) -> Result<bool> {
        self.ctx.metadata(descendant)?.is_descendant(&self.id)
    }

    /// The changes this one actually targets: declared parents, or the default branch when none
    /// are declared, with archived ones replaced by their own parents.
    // TODO-someday(joel): store computed parents?
    pub fn parents(&self) -> Result<BTreeSet<ChangeId>> {
        if self.archived {
            return Ok(self.declared_parents.clone());
        }

        let mut candidates = BTreeSet::new();
        let mut frontier: Vec<_> = self.declared_parents.iter().cloned().collect();
        if frontier.is_empty() {
            let default = self.ctx.default_branch()?;
            if default != self.id {
                frontier.push(default);
            }
        }
        while let Some(candidate_id) = frontier.pop() {
            let candidate = self.ctx.metadata(&candidate_id)?;
            // skip archived parents and land into their parents
            if candidate.archived {
                frontier.extend(candidate.declared_parents.iter().cloned());
            } else {
                candidates.insert(candidate_id);
            }
        }
        self.ctx.maximal_changes(&candidates)
    }
}

impl<'ctx> TransactionContext<'ctx> {
    /// `changes` without any that is an ancestor of another of them.
    pub fn maximal_changes(&'ctx self, changes: &BTreeSet<ChangeId>) -> Result<BTreeSet<ChangeId>> {
        let mut candidates = changes.clone();

        for candidate_id in changes {
            let candidate = self.metadata(candidate_id)?;
            for other in &candidates {
                if candidate_id != other && candidate.is_ancestor(other)? {
                    candidates.remove(candidate_id);
                    break;
                }
            }
        }

        Ok(candidates)
    }
}

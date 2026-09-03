use std::collections::{BTreeMap, BTreeSet};

use crate::{
    context::TransactionContext,
    error::Result,
    types::{ChangeId, ChangeIdRef, Identity, RepoPath, Revision, RevisionRange, WorkspaceId},
};

/// A change's state as of some instant, detached from any transaction. A change is a
/// [`ChangeId`] with two independently written resources behind it, its [`Metadata`](crate::metadata::Metadata)
/// and its [`Branch`](crate::branch::Branch); this is the two read together for showing.
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "napi", napi_derive::napi(object, object_from_js = false))]
pub struct ChangeSnapshot {
    pub tip: Revision,
    pub title: Option<String>,
    pub description: Option<String>,
    pub archived: bool,
    pub permanent: bool,
    pub owners: BTreeSet<Identity>,
    /// What the change targets; see [`Metadata::parents`](crate::metadata::Metadata::parents).
    pub parents: BTreeSet<ChangeId>,
    /// What its log declares, which is what parent edits act on.
    pub declared_parents: BTreeSet<ChangeId>,
    pub review: BTreeMap<Identity, BTreeMap<RepoPath, RevisionRange>>,
    /// Where the change is checked out; see [`Branch::workspace`](crate::branch::Branch::workspace).
    pub workspace: Option<WorkspaceId>,
}

impl<'ctx> TransactionContext<'ctx> {
    pub fn snapshot(&'ctx self, change_id: &ChangeIdRef) -> Result<ChangeSnapshot> {
        let (metadata, branch) = (self.metadata(change_id)?, self.branch(change_id)?);
        Ok(ChangeSnapshot {
            tip: branch.tip,
            title: metadata.title.clone(),
            description: metadata.description.clone(),
            archived: metadata.archived,
            permanent: metadata.permanent,
            owners: metadata.owners.clone(),
            parents: metadata.parents()?,
            declared_parents: metadata.declared_parents.clone(),
            review: metadata.review.clone(),
            workspace: branch.workspace()?,
        })
    }
}

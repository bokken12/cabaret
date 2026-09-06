use std::collections::{BTreeMap, BTreeSet};

use crate::{
    change_id::ChangeId,
    identity::Identity,
    repo_path::RepoPath,
    revision::{RevisionId, RevisionRange},
    workspace_id::WorkspaceId,
};

/// A change's state as of some instant, detached from any transaction. A change is a
/// [`ChangeId`] with two independently written resources behind it, its `Metadata` and its
/// `Branch`; this is the two read together for showing.
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "napi", napi_derive::napi(object, object_from_js = false))]
pub struct ChangeSnapshot {
    pub tip: RevisionId,
    /// What the tip is measured against; see `Branch::bases`.
    pub bases: BTreeSet<RevisionId>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub archived: bool,
    pub permanent: bool,
    pub owners: BTreeSet<Identity>,
    /// What the change targets; see `Metadata::parents`.
    pub parents: BTreeSet<ChangeId>,
    /// What its log declares, which is what parent edits act on.
    pub declared_parents: BTreeSet<ChangeId>,
    pub review: BTreeMap<Identity, BTreeMap<RepoPath, RevisionRange>>,
    /// Where the change is checked out; see `Branch::workspace`.
    pub workspace: Option<WorkspaceId>,
}

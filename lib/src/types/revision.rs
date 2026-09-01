use std::{collections::BTreeSet, fmt};

use gix::ObjectId;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::{cabaret::Cabaret, context::TransactionContext, error::Result};

// TODO-someday(joel): extract serialize-as-hash as its own type?
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Revision(pub ObjectId);

impl fmt::Display for Revision {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { fmt::Display::fmt(&self.0, f) }
}

impl From<Revision> for ObjectId {
    fn from(revision: Revision) -> Self { revision.0 }
}

impl Serialize for Revision {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.collect_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Revision {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let hex = String::deserialize(deserializer)?;
        hex.parse().map(Revision).map_err(serde::de::Error::custom)
    }
}

// TODO(joel): consider making `'ctx`-parameterized?
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
pub struct RevisionRange {
    pub base: Revision,
    pub head: Revision,
}

impl<'ctx> TransactionContext<'ctx> {
    pub fn merge_base(&self, one: Revision, two: Revision) -> Result<Revision> {
        // TODO(joel): use `merge_base_with_graph`
        Ok(Revision(self.repo.merge_base(one, two)?.detach()))
    }

    pub fn is_predecessor(&self, predecessor: Revision, successor: Revision) -> Result<bool> {
        Ok(self.merge_base(predecessor, successor)? == predecessor)
    }

    /// `ctx.maximal_revisions(revisions)` returns the subset of `revisions` which have no predecessor under `ctx`.
    pub fn maximal_revisions(&self, revisions: &BTreeSet<Revision>) -> Result<BTreeSet<Revision>> {
        let mut candidates = revisions.clone();

        for &candidate in revisions.iter() {
            for &other in candidates.iter() {
                if candidate != other && self.is_predecessor(candidate, other)? {
                    candidates.remove(&candidate);
                    break;
                }
            }
        }

        Ok(candidates)
    }
}

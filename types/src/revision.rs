use std::{collections::BTreeSet, fmt};

use gix::ObjectId;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

// TODO-someday(joel): extract serialize-as-hash as its own type?
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct RevisionId(pub ObjectId);

impl fmt::Display for RevisionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { fmt::Display::fmt(&self.0, f) }
}

impl From<RevisionId> for ObjectId {
    fn from(revision: RevisionId) -> Self { revision.0 }
}

impl Serialize for RevisionId {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.collect_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for RevisionId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let hex = String::deserialize(deserializer)?;
        hex.parse().map(RevisionId).map_err(serde::de::Error::custom)
    }
}

/// The span a diff covers: from a change's bases to its tip. The bases are kept rather than the
/// virtual commit they merge into, since that commit lives only in the object database of
/// whoever computed it.
// TODO(joel): consider making `'ctx`-parameterized?
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
pub struct RevisionRange {
    pub bases: BTreeSet<RevisionId>,
    pub head: RevisionId,
}

use std::fmt;

use gix::ObjectId;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::{cabaret::Cabaret, error::Result};

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

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
pub struct RevisionRange {
    pub base: Revision,
    pub head: Revision,
}

impl Cabaret {
    pub fn merge_base(&self, one: Revision, two: Revision) -> Result<Revision> {
        Ok(Revision(self.repo.merge_base(one.0, two.0)?.detach()))
    }

    // TODO(joel): rename to `is_predecessor`?
    pub fn rev_is_ancestor(&self, predecessor: Revision, successor: Revision) -> Result<bool> {
        Ok(self.repo.merge_base(predecessor.0, successor.0)? == predecessor.0)
    }
}

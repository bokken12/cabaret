use std::{collections::BTreeSet, fmt};

use gix::ObjectId;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TimestampMs(pub u64);

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ChangeId(pub String);

impl fmt::Display for ChangeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

// TODO-someday(joel): extract serialize-as-hash as its own type?
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Revision(pub ObjectId);

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

pub struct Change {
    // TODO-someday(jm): add other relevant data
    pub parents: BTreeSet<ChangeId>,
}

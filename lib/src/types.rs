use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    path::PathBuf,
    str::FromStr,
};

use gix::{
    ObjectId,
    bstr::BStr,
    pathspec,
    refs::{FullName, PartialName},
};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TimestampMs(pub u64);

impl TimestampMs {
    pub fn now() -> Self {
        let since_epoch = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock is before the Unix epoch");
        Self(u64::try_from(since_epoch.as_millis()).expect("timestamp overflows u64"))
    }
}

// TODO-someday(joel): rename to "user" or "email"?
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Identity(pub String);

impl From<String> for Identity {
    fn from(s: String) -> Self { Self(s) }
}

impl fmt::Display for Identity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(&self.0) }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ChangeId(PartialName);

impl ChangeId {
    pub const LOG_REF_PREFIX: &'static str = "refs/cabaret/changes/";

    pub fn branch_ref(&self) -> FullName {
        FullName::try_from(format!("refs/heads/{self}")).expect("a partial name is valid under refs/heads/")
    }

    pub fn log_ref(&self) -> FullName {
        FullName::try_from(format!("{}{self}", Self::LOG_REF_PREFIX))
            .expect("a partial name is valid under refs/cabaret/changes/")
    }

    pub fn as_bstr(&self) -> &BStr { self.0.as_ref().as_bstr() }
}

impl fmt::Display for ChangeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { fmt::Display::fmt(self.as_bstr(), f) }
}

impl FromStr for ChangeId {
    type Err = gix::refs::name::Error;

    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> { PartialName::try_from(s).map(Self) }
}

impl Serialize for ChangeId {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for ChangeId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        String::deserialize(deserializer)?.parse().map_err(serde::de::Error::custom)
    }
}

// TODO(joel): reconsider path representation
/// repo-relative & platform-agnostic path
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Path(pub Vec<u8>);

impl Serialize for Path {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> { todo!() }
}

impl<'de> Deserialize<'de> for Path {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> { todo!() }
}

// TODO(joel): rename to be less ambiguous?
#[derive(Debug, Clone)]
pub struct Pathspec(pub pathspec::Pattern);

impl FromStr for Pathspec {
    type Err = pathspec::parse::Error;

    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        pathspec::parse(s.as_bytes(), pathspec::Defaults::default()).map(Self)
    }
}

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TreeId(pub ObjectId);

impl From<TreeId> for ObjectId {
    fn from(tree: TreeId) -> Self { tree.0 }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct RevisionRange {
    base: Revision,
    head: Revision,
}

// TODO-someday(joel): rename? metdata? info? log data?
pub struct Change {
    // TODO-someday(joel): add other relevant data
    pub title: Option<String>,
    pub description: Option<String>,
    pub owners: BTreeSet<Identity>,
    pub parents: BTreeSet<ChangeId>,
    // TODO(joel): fix path type
    pub review_state: BTreeMap<Identity, BTreeMap<Path, RevisionRange>>,
}

impl Change {
    pub fn new() -> Self {
        Self {
            title: None,
            description: None,
            owners: BTreeSet::new(),
            parents: BTreeSet::new(),
            review_state: BTreeMap::new(),
        }
    }
}

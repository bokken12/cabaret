use std::{fmt, str::FromStr};

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

impl AsRef<str> for Identity {
    fn as_ref(&self) -> &str { &self.0 }
}

impl fmt::Display for Identity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(&self.0) }
}

// TODO(joel): move to change.rs?
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

/// Repo-relative path: UTF-8, `/`-separated, no empty, `.`, or `..` components.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct RepoPath(String);

impl RepoPath {
    pub fn from_bytes(bytes: &BStr) -> crate::error::Result<Self> { Ok(std::str::from_utf8(bytes)?.parse()?) }
}

impl FromStr for RepoPath {
    type Err = String;

    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        if s.is_empty() {
            return Err("path is empty".into());
        }
        if s.contains('\0') {
            return Err(format!("path {s:?} contains NUL"));
        }
        for component in s.split('/') {
            if let "" | "." | ".." = component {
                return Err(format!("path {s:?} has a {component:?} component"));
            }
        }
        Ok(Self(s.to_owned()))
    }
}

impl AsRef<str> for RepoPath {
    fn as_ref(&self) -> &str { &self.0 }
}

impl fmt::Display for RepoPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(&self.0) }
}

impl Serialize for RepoPath {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for RepoPath {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        String::deserialize(deserializer)?.parse().map_err(serde::de::Error::custom)
    }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TreeId(pub ObjectId);

impl From<TreeId> for ObjectId {
    fn from(tree: TreeId) -> Self { tree.0 }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi_derive::napi(string_enum))]
pub enum Liveness {
    /// Intended to land
    Live,
    /// Landed or abandoned
    Archived,
    /// Umbrella for children
    Permanent,
}

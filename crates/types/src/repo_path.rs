use std::{fmt, str::FromStr};

use gix::bstr::BStr;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Repo-relative path: UTF-8, `/`-separated, no empty, `.`, or `..` components.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct RepoPath(String);

impl fmt::Debug for RepoPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { fmt::Debug::fmt(&self.0, f) }
}

impl RepoPath {
    pub fn from_bytes(bytes: &BStr) -> crate::error::Result<Self> { Ok(std::str::from_utf8(bytes)?.parse()?) }

    pub fn as_bstr(&self) -> &BStr { self.0.as_str().into() }
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

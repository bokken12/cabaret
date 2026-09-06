//! Coding agents that work in cabaret workspaces.

use std::fmt;

use cabaret_types::TimestampMs;
use serde::Deserialize;

mod acp;

pub use acp::Acp;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize)]
#[serde(transparent)]
pub struct SessionId(pub String);

impl fmt::Display for SessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(&self.0) }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub id: SessionId,
    pub title: Option<String>,
    pub last_active: TimestampMs,
}

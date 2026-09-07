//! Coding agents that work in cabaret workspaces.

use std::fmt;

use cabaret_types::TimestampMs;
use serde::Deserialize;

mod claude_code;

pub use claude_code::ClaudeCode;

#[cfg(feature = "napi")]
mod napi {
    use napi::{
        bindgen_prelude::{FromNapiValue, ToNapiValue},
        sys,
    };

    use crate::SessionId;

    impl ToNapiValue for SessionId {
        unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
            unsafe { String::to_napi_value(env, val.0) }
        }
    }

    impl FromNapiValue for SessionId {
        unsafe fn from_napi_value(env: sys::napi_env, val: sys::napi_value) -> napi::Result<Self> {
            Ok(Self(unsafe { String::from_napi_value(env, val)? }))
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize)]
#[serde(transparent)]
pub struct SessionId(pub String);

impl fmt::Display for SessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(&self.0) }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub id: SessionId,
    /// The title Claude Code generated for the session, else the first line of its first prompt.
    pub title: Option<String>,
    /// When the last user or assistant message was recorded. The transcript itself is written to
    /// later than that, by bookkeeping lines such as away summaries.
    pub last_active: TimestampMs,
    /// Present while the session is registered as running. Claude Code removes the registration on
    /// exit, so a crashed session stays registered.
    pub live: Option<Status>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Busy,
    Idle,
    /// A status this crate predates, or none reported yet.
    #[serde(other)]
    Unknown,
}

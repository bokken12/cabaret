//! Harness adapters for local session discovery, linking and resume.
//!
//! Contributors: copy `examples/harness_template.rs`, implement `Harness`, and register it in
//! `Harnesses::locate`. The template includes the complete wiring and fixture-test checklist.
//!
//! Claude status: history discovery, manual links and resume work. Automatic caller identity and
//! launch-directory lookup are NOT IMPLEMENTED; see the TODO in claude_code.rs.
//
// TODO(joel): In a good end state, Cabaret should not contain one-off hacky integrations like this. I suspect the right
// solution is to find or create a second VSCode extension which is just "agents in VSCode buffers" via the
// Zed/JetBrains ACP, which Cabaret could query / hand off to.

use std::{fmt, path::PathBuf};

use cabaret_types::TimestampMs;
use serde::{Deserialize, Serialize};

mod claude_code;
mod codex;
mod harness;

pub use claude_code::ClaudeCode;
pub use codex::Codex;
pub use harness::{Harness, HarnessInfo, Harnesses, HarnessesCache, ResumeCommand};

#[cfg(feature = "napi")]
// Avoid shadowing the external napi crate used by generated enum bindings.
mod napi_impl {
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

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(transparent)]
pub struct SessionId(pub String);

impl fmt::Display for SessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(&self.0) }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub provider: Provider,
    pub directory: PathBuf,
    pub id: SessionId,
    /// A provider-supplied title or the first line of its first prompt.
    pub title: Option<String>,
    /// Most recent recorded activity found in local history; absent when history is unavailable.
    pub last_active: Option<TimestampMs>,
    /// Provider-reported live status, if available. History timestamps are not liveness.
    /// A registration can outlive a crashed process; None means live status is unavailable.
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

/// The harness owning a session; identifiers are only unique within a provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "napi", napi_derive::napi(string_enum))]
pub enum Provider {
    Claude,
    Codex,
}

impl fmt::Display for Provider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self { Self::Claude => "claude", Self::Codex => "codex" })
    }
}

/// Reject path traversal and shell metacharacters before looking up or resuming a session.
pub fn validate_session_id(id: &SessionId) -> cabaret_types::Result<()> {
    if id.0.is_empty() || id.0.len() > 128 || !id.0.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')) {
        return Err("session IDs must contain only letters, digits, hyphens and underscores (up to 128 characters)".into());
    }
    Ok(())
}

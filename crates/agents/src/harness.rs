//! Harness integration contract. Start with `examples/harness_template.rs`.
//!
//! Add a stable Provider variant + Display spelling in lib.rs, then register one adapter in
//! Harnesses::locate below. CLI choices, editor linking and resume all use this registry.
//! This is a source-level extension point, not a runtime plugin loader.

use crate::{ClaudeCode, Codex, Provider, Session, SessionId, validate_session_id};
use cabaret_types::Result;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Debug, Clone)]
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
pub struct HarnessInfo {
    pub provider: Provider,
    pub label: String,
    /// Whether explicit lookup still needs the original launch directory.
    pub requires_directory: bool,
    /// Explain how to identify the calling session, including unimplemented capabilities.
    pub identification: String,
}

/// A program and separate arguments, never an interpolated shell command.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
pub struct ResumeCommand {
    pub program: String,
    pub args: Vec<String>,
    pub directory: String,
}

/// One adapter owns all knowledge of its harness's history format and resume protocol.
/// Reading these methods must never start/resume a session or scan unrelated worktrees.
pub trait Harness: Send + Sync {
    fn info(&self) -> HarnessInfo;
    /// Missing history is an empty list. Preserve the real launch directory on each session.
    /// Bound/cache history reads; never interpret recent activity as proof of liveness.
    fn sessions_in(&self, directory: &Path) -> Result<Vec<Session>>;
    /// Optional legacy discovery after a checkout is removed. Default avoids inferring sessions
    /// from a path that may never have existed. Claude preserves its prior exact-directory lookup.
    fn sessions_without_checkout(&self, _default_directory: &Path) -> Result<Vec<Session>> {
        Ok(Vec::new())
    }
    /// Look up one exact ID. None means history was removed or is not available locally.
    /// Validate IDs before constructing paths. Directory is a lookup hint, not the target worktree.
    fn session(&self, id: &SessionId, directory: Option<&Path>) -> Result<Option<Session>>;
    /// Identify this caller using a harness-provided ID, never the newest or only history entry.
    /// None means no identity is available; CLI then asks for --id explicitly.
    fn current_session_id(&self) -> Result<Option<SessionId>>;
    /// Describe how to reopen a session; do not launch it here. Keep argv separate from the program.
    fn resume(&self, id: &SessionId, directory: &Path) -> Result<ResumeCommand>;
}

/// Persistent adapters retain caches between editor refreshes.
pub struct Harnesses(Vec<Box<dyn Harness>>);

/// Set up optional session tooling only when requested; cache successful setup, not failures.
#[derive(Default)]
pub struct HarnessesCache(Mutex<Option<Arc<Harnesses>>>);

impl HarnessesCache {
    pub fn get(&self) -> Result<Arc<Harnesses>> { self.get_with(Harnesses::locate) }

    fn get_with(&self, locate: impl FnOnce() -> Result<Harnesses>) -> Result<Arc<Harnesses>> {
        let mut cached = self.0.lock().map_err(|_| "harness setup lock poisoned")?;
        if let Some(harnesses) = cached.as_ref() {
            return Ok(Arc::clone(harnesses));
        }
        let harnesses = Arc::new(locate()?);
        *cached = Some(Arc::clone(&harnesses));
        Ok(harnesses)
    }
}

impl Harnesses {
    pub fn new(adapters: Vec<Box<dyn Harness>>) -> Result<Self> {
        let mut seen = std::collections::HashSet::new();
        for adapter in &adapters {
            if !seen.insert(adapter.info().provider) {
                return Err("duplicate harness provider registration".into());
            }
        }
        Ok(Self(adapters))
    }

    pub fn locate() -> Result<Self> {
        // Registration point for new adapters. Also add the Provider enum variant in lib.rs.
        Self::new(vec![Box::new(ClaudeCode::locate()?), Box::new(Codex::locate()?)])
    }

    pub fn iter(&self) -> impl Iterator<Item = &dyn Harness> {
        self.0.iter().map(|adapter| adapter.as_ref())
    }

    pub fn get(&self, provider: Provider) -> Result<&dyn Harness> {
        self.iter()
            .find(|adapter| adapter.info().provider == provider)
            .ok_or_else(|| format!("no adapter registered for {provider}").into())
    }

    pub fn named(&self, name: &str) -> Result<&dyn Harness> {
        self.iter()
            .find(|adapter| adapter.info().provider.to_string() == name)
            .ok_or_else(|| format!("unknown session provider {name:?}; run cab session providers").into())
    }

    // Protect the registry boundary even for new adapters. Built-in adapters also validate
    // in resume_command because callers can invoke their Harness::resume method directly.
    pub fn resume(&self, provider: Provider, id: &SessionId, directory: &Path) -> Result<ResumeCommand> {
        validate_session_id(id)?;
        if !directory.is_absolute() {
            return Err("session launch directory must be absolute".into());
        }
        self.get(provider)?.resume(id, directory)
    }
}

pub(crate) fn resume_command(program: &str, args: &[&str], id: &SessionId, directory: &Path) -> Result<ResumeCommand> {
    validate_session_id(id)?;
    if !directory.is_absolute() {
        return Err("session launch directory must be absolute".into());
    }
    let directory = PathBuf::from(directory)
        .into_os_string()
        .into_string()
        .map_err(|_| "session launch directory is not UTF-8")?;
    Ok(ResumeCommand {
        program: program.into(),
        args: args
            .iter()
            .map(|arg| (*arg).to_owned())
            .chain(std::iter::once(id.0.clone()))
            .collect(),
        directory,
    })
}

#[cfg(test)]
mod cache_tests {
    use super::*;

    #[test]
    fn optional_setup_is_deferred_retries_failure_and_reuses_success() {
        let cache = HarnessesCache::default();
        assert!(cache.0.lock().unwrap().is_none());
        assert!(cache.get_with(|| Err("home directory unavailable".into())).is_err());
        assert!(cache.0.lock().unwrap().is_none());
        let first = cache.get_with(|| Harnesses::new(Vec::new())).unwrap();
        let again = cache.get_with(|| panic!("successful setup must be reused")).unwrap();
        assert!(Arc::ptr_eq(&first, &again));
    }
}

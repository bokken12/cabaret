//! Use this template to add support for a coding harness.
//!
//! # Getting started
//!
//! 1. Copy this file to `src/<your_harness>.rs` and rename `YourHarness`.
//!    Implement the TODOs, then remove `main()` and the example test at the bottom.
//! 2. In `src/lib.rs`, declare your module and add a `Provider` variant with a
//!    `Display` name. Choose a permanent name: saved session links use it.
//! 3. In `src/harness.rs`, add this adapter to `Harnesses::locate`:
//!    `Box::new(YourHarness::locate(Provider::YourHarness)?)`.
//!
//! Optionally override `sessions_without_checkout` if your harness can find history
//! at a worktree's default path after that worktree is removed. It returns no sessions
//! by default.
//!

use cabaret_agents::{Harness, HarnessInfo, Provider, ResumeCommand, Session, SessionId};
use cabaret_types::Result;
use std::path::{Path, PathBuf};

pub struct YourHarness {
    provider: Provider,
    // Tests can pass a temporary history directory here.
    _history_root: PathBuf,
}

impl YourHarness {
    pub fn new(provider: Provider, history_root: PathBuf) -> Self {
        Self {
            provider,
            _history_root: history_root,
        }
    }

    pub fn locate(_provider: Provider) -> Result<Self> {
        // TODO: Find the history directory. Respect the harness's configuration override,
        // then fall back to its usual location under the user's home directory.
        // This should work even if the CLI is not installed. Do not start a process.
        Err("TODO: locate this harness's history storage".into())
    }
}

impl Harness for YourHarness {
    fn info(&self) -> HarnessInfo {
        HarnessInfo {
            provider: self.provider,
            label: "Your harness (not implemented)".into(),
            // Set to false once session(id, None) can find the original launch directory.
            requires_directory: true,
            identification: "Automatic caller identification is not implemented; supply --id and --directory.".into(),
        }
    }

    fn sessions_in(&self, _directory: &Path) -> Result<Vec<Session>> {
        // TODO: Find sessions started in this directory. State whether subdirectories count.
        // For each session, return its provider, ID, absolute launch directory, title,
        // last activity time, and live status.
        //
        // Return an empty list when history is missing. Use None for unknown activity
        // or live status: a recent history file or stale process record does not prove
        // that a session is running.
        //
        // Limit how much history you read and cache lookups between refreshes.
        Err("TODO: discover and parse session history/activity/status".into())
    }

    fn session(&self, _id: &SessionId, _directory: Option<&Path>) -> Result<Option<Session>> {
        // TODO: Validate the ID before using it in a path, then find that exact session.
        // Read its original launch directory from history if possible. This may differ
        // from the worktree the user is linking it to.
        //
        // Return None when history is missing. Report malformed data without deleting it.
        Err("TODO: find history by exact ID and recover the launch directory".into())
    }

    fn current_session_id(&self) -> Result<Option<SessionId>> {
        // TODO: Ask the harness which session is calling Cabaret, using an environment
        // variable, hook, or other supported way of communicating with the harness.
        // Do not guess from the newest session: several agents may share a worktree.
        //
        // If this is not supported yet, return None and explain the limitation in info().
        // Users can still link sessions by supplying --id.
        Ok(None)
    }

    fn resume(&self, _id: &SessionId, _directory: &Path) -> Result<ResumeCommand> {
        // TODO: Return the executable, its arguments, and the absolute launch directory.
        // For example: program "your-cli", args ["resume", id].
        //
        // Keep arguments separate instead of joining them into a shell command.
        // The editor launches the program; this method only describes how to launch it.
        Err("TODO: construct the harness's resume command".into())
    }
}

fn main() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unfinished_template_never_claims_to_find_or_resume_a_session() {
        // Codex is a placeholder here so the example compiles. This adapter is not registered.
        let adapter = YourHarness::new(Provider::Codex, PathBuf::from("/fixture/history"));
        assert!(adapter.current_session_id().unwrap().is_none());
        assert!(adapter.sessions_in(Path::new("/fixture/worktree")).is_err());
        assert!(adapter.session(&SessionId("example".into()), None).is_err());
        assert!(
            adapter
                .resume(&SessionId("example".into()), Path::new("/fixture/worktree"))
                .is_err()
        );
    }
}

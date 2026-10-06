mod cabaret;
mod discovery;
mod sessions;
#[cfg(feature = "napi")]
mod node;

pub use discovery::discover_repositories;
pub use cabaret::{Cabaret, Prune, Rebase};
pub use cabaret_agents::{Harness, HarnessInfo, Harnesses, ResumeCommand, ClaudeCode, Codex, Provider, Session, SessionId, Status, validate_session_id};
pub use sessions::SessionLink;
pub use cabaret_config::{FetchInterval, Hints, Prefix, Scope, Setting};
pub use cabaret_page::{
    DiffView, FileTree, Fold, Home, HomeGraph, HomeNode, HomeSection, Line, NextStep, Page, Segment, TabCounts, Tag,
    Target, name,
};
pub use cabaret_types::{
    ChangeId, ChangeIdRef, ChangeSnapshot, ChangedFile, Error, FileDiff, FileVersion, Identity, LineCounts, Pathspec,
    RepoPath, Result, RevisionId, TimestampMs, TreeId, ViewDiff, WorkspaceId, WorkspaceIdRef, is_binary, line_diff,
    log, safeguard,
};
pub use gix;

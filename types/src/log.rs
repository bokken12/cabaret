//! The log each change's metadata is stored as: append-only entries behind a ref, folded on
//! read and merged by union across devices.

use serde::{Deserialize, Serialize};

use crate::{
    RevisionId, change_id::ChangeId, error::Result, identity::Identity, repo_path::RepoPath, timestamp::TimestampMs,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum LogAction {
    AddOwner { owner: Identity },
    AddParent { parent: ChangeId },
    Forget { reviewer: Identity, file: RepoPath },
    Mark { reviewer: Identity, file: RepoPath, revision: RevisionId },
    RemoveOwner { owner: Identity },
    RemoveParent { parent: ChangeId },
    SetArchived { archived: bool },
    // TODO(joel): remove this entry
    // No longer written: the description lives in its own file beside the log, where git merges
    // it. Kept so logs from before then still read.
    SetDescription { description: Option<String> },
    SetPermanent { permanent: bool },
    SetTitle { title: Option<String> },
}

// TODO-someday(joel): move log to its own crate?
// TODO-someday(joel): allow format evolution. protos? versioned?
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: TimestampMs,
    pub user: Identity,
    #[serde(flatten)]
    pub action: LogAction,
}

/// The entries of a log stored as `text`, oldest first.
pub fn parse(text: &str) -> Result<Vec<LogEntry>> { text.lines().map(|line| Ok(serde_json::from_str(line)?)).collect() }

/// `entries` as they are stored: one JSON object per line.
pub fn render(entries: &[LogEntry]) -> Result<String> {
    let mut text = String::new();
    for entry in entries {
        text.push_str(&serde_json::to_string(entry)?);
        text.push('\n');
    }
    Ok(text)
}

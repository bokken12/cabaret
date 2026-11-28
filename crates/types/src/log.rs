//! The log each change's metadata is stored as: every write commits its own actions behind the
//! change's ref, on the commits it saw, and reading folds them in the order that graph implies.

use serde::{Deserialize, Serialize};

use crate::{
    ForgeEventId, Reviewing, RevisionId, TimestampS, change_id::ChangeId, error::Result, identity::Identity,
    repo_path::RepoPath,
};

// TODO-someday(joel): move log to its own crate?
// TODO-someday(joel): allow format evolution. protos? versioned?
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum LogAction {
    AddOwner { owner: Identity },
    AddParent { parent: ChangeId },
    Endorse { endorser: Identity },
    // TODO-someday(joel): `files: NEBTreeSet<RepoPath>`
    Forget { reviewer: Identity, file: RepoPath },
    Mark { reviewer: Identity, file: RepoPath, revision: RevisionId },
    RemoveOwner { owner: Identity },
    RemoveParent { parent: ChangeId },
    SetArchived { archived: bool },
    SetPermanent { permanent: bool },
    SetReviewing { reviewing: Reviewing },
    SetTitle { title: Option<String> },
    Unendorse { endorser: Identity },
}

impl LogAction {
    /// The revision this refers to, which its commit takes as a parent so that it is fetched and
    /// kept for as long as the log is.
    pub fn revision(&self) -> Option<RevisionId> {
        match self {
            LogAction::Mark { revision, .. } => Some(*revision),
            _ => None,
        }
    }
}

/// One event of a forge change's history, as importing it records in the log. Everything here is
/// the forge's own, so that every device importing the event records the same.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgeEvent {
    pub id: ForgeEventId,
    /// Who the forge says caused the event.
    pub author: Identity,
    /// When the forge says it happened.
    pub time: TimestampS,
    /// What the event does to the change.
    pub actions: Vec<LogAction>,
}

/// The actions stored as `text`, in the order they were taken.
pub fn parse(text: &str) -> Result<Vec<LogAction>> {
    text.lines().map(|line| Ok(serde_json::from_str(line)?)).collect()
}

/// `actions` as they are stored: one JSON object per line.
pub fn render(actions: &[LogAction]) -> Result<String> {
    let mut text = String::new();
    for action in actions {
        text.push_str(&serde_json::to_string(action)?);
        text.push('\n');
    }
    Ok(text)
}

//! The log each change's metadata is stored as: every write commits its own actions behind the
//! change's ref, on the commits it saw, and reading folds them in the order that graph implies.

use serde::{Deserialize, Serialize};

use crate::{RevisionId, change_id::ChangeId, error::Result, identity::Identity, repo_path::RepoPath};

// TODO-someday(joel): move log to its own crate?
// TODO-someday(joel): allow format evolution. protos? versioned?
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum LogAction {
    AddOwner { owner: Identity },
    AddParent { parent: ChangeId },
    Forget { reviewer: Identity, file: RepoPath },
    Land { change: ChangeId, log: Option<RevisionId> },
    Mark { reviewer: Identity, file: RepoPath, revision: RevisionId },
    RemoveOwner { owner: Identity },
    RemoveParent { parent: ChangeId },
    SetArchived { archived: bool },
    SetPermanent { permanent: bool },
    SetTitle { title: Option<String> },
}

impl LogAction {
    /// The commit this refers to, which its log commit takes as a parent so that it is fetched and
    /// kept for as long as the log is.
    pub fn referenced(&self) -> Option<RevisionId> {
        match self {
            LogAction::Land { log, .. } => *log,
            LogAction::Mark { revision, .. } => Some(*revision),
            _ => None,
        }
    }
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

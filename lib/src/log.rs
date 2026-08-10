use std::collections::BTreeSet;

use gix::Repository;
use serde::{Deserialize, Serialize};

use crate::cabaret::Cabaret;
use crate::error::{Error, Result};
use crate::types::{Change, ChangeId, TimestampMs};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum LogAction {
    AddParent { parent: ChangeId },
    RemoveParent { parent: ChangeId },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: TimestampMs,
    // TODO-someday(joel): add user
    // pub user: String,
    #[serde(flatten)]
    pub action: LogAction,
}

fn read_entries(repo: &Repository, change: &ChangeId) -> Result<Vec<LogEntry>> {
    let ref_name = format!("refs/cabaret/changes/{change}");
    let mut reference = repo.find_reference(&ref_name).map_err(Error::new)?;
    let tree = reference.peel_to_tree().map_err(Error::new)?;
    let entry = tree
        .find_entry("log.jsonl")
        .ok_or_else(|| Error::new(format!("{ref_name} has no log.jsonl")))?;
    let blob = entry
        .object()
        .map_err(Error::new)?
        .try_into_blob()
        .map_err(Error::new)?;
    let text = std::str::from_utf8(&blob.data).map_err(Error::new)?;
    text.lines()
        .map(|line| serde_json::from_str(line).map_err(Error::new))
        .collect::<Result<Vec<LogEntry>>>()
}

fn change_of_entries(log: &[LogEntry]) -> Change {
    let mut change = Change {
        parents: BTreeSet::new(),
    };
    for entry in log {
        match &entry.action {
            LogAction::AddParent { parent } => {
                change.parents.insert(parent.clone());
            }
            LogAction::RemoveParent { parent } => {
                change.parents.remove(parent);
            }
        }
    }
    change
}

impl Cabaret {
    pub fn change(&self, change: &ChangeId) -> Result<Change> {
        Ok(change_of_entries(&read_entries(&self.repo, change)?))
    }

    pub fn add_parent(&self, change: &ChangeId, parent: &ChangeId) -> Result<()> {
        todo!()
    }

    pub fn remove_parent(&self, change: &ChangeId, parent: &ChangeId) -> Result<()> {
        todo!()
    }
}

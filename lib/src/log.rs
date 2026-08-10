use gix::{ObjectId, Repository};
use serde::{Deserialize, Serialize};

use crate::cabaret::Cabaret;
use crate::error::{Error, Result};
use crate::types::{Change, ChangeId, Identity, TimestampMs};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum LogAction {
    AddOwner { owner: Identity },
    AddParent { parent: ChangeId },
    RemoveOwner { owner: Identity },
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

impl Change {
    /// `change.apply(action)` is `true` iff `action` modifies `change`.
    pub(crate) fn apply(&mut self, action: &LogAction) -> bool {
        match action {
            LogAction::AddOwner { owner } => self.owners.insert(owner.clone()),
            LogAction::AddParent { parent } => self.parents.insert(parent.clone()),
            LogAction::RemoveOwner { owner } => self.owners.remove(owner),
            LogAction::RemoveParent { parent } => self.parents.remove(parent),
        }
    }
}

const LOG_FILE: &str = "log.jsonl";

fn ref_name(change: &ChangeId) -> String {
    format!("refs/cabaret/changes/{change}")
}

struct Log {
    head: ObjectId,
    text: String,
    change: Change,
}

impl Log {
    fn read(repo: &Repository, change: &ChangeId) -> Result<Log> {
        let ref_name = ref_name(change);
        let mut reference = repo.find_reference(&ref_name).map_err(Error::new)?;
        let commit = reference.peel_to_commit().map_err(Error::new)?;
        let tree = commit.tree().map_err(Error::new)?;
        let entry = tree
            .find_entry(LOG_FILE)
            .ok_or_else(|| Error::new(format!("{ref_name} has no {LOG_FILE}")))?;
        let blob = entry
            .object()
            .map_err(Error::new)?
            .try_into_blob()
            .map_err(Error::new)?;
        let text = std::str::from_utf8(&blob.data)
            .map_err(Error::new)?
            .to_owned();
        let mut change = Change::new();
        for line in text.lines() {
            let entry: LogEntry = serde_json::from_str(line).map_err(Error::new)?;
            change.apply(&entry.action);
        }
        Ok(Log {
            head: commit.id,
            text,
            change,
        })
    }
}

impl Cabaret {
    pub fn change(&self, change: &ChangeId) -> Result<Change> {
        Ok(Log::read(&self.repo, change)?.change)
    }

    fn record(&self, change: &ChangeId, action: LogAction) -> Result<()> {
        let mut log = Log::read(&self.repo, change)?;
        if !log.change.apply(&action) {
            return Ok(());
        }
        self.append(change, log, action)
    }

    fn append(&self, change: &ChangeId, log: Log, action: LogAction) -> Result<()> {
        let message = serde_json::to_string(&action).map_err(Error::new)?;
        let entry = LogEntry {
            timestamp: TimestampMs::now(),
            action,
        };
        let line = serde_json::to_string(&entry).map_err(Error::new)?;
        let mut text = log.text;
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&line);
        text.push('\n');
        let blob = self.repo.write_blob(text.as_bytes()).map_err(Error::new)?;
        let tree = gix::objs::Tree {
            entries: vec![gix::objs::tree::Entry {
                mode: gix::objs::tree::EntryKind::Blob.into(),
                filename: LOG_FILE.into(),
                oid: blob.detach(),
            }],
        };
        let tree = self.repo.write_object(&tree).map_err(Error::new)?;
        self.repo
            .commit(ref_name(change).as_str(), message, tree, [log.head])
            .map_err(Error::new)?;
        Ok(())
    }

    pub fn add_parent(&self, change: &ChangeId, parent: &ChangeId) -> Result<()> {
        self.record(
            change,
            LogAction::AddParent {
                parent: parent.clone(),
            },
        )
    }

    pub fn remove_parent(&self, change: &ChangeId, parent: &ChangeId) -> Result<()> {
        self.record(
            change,
            LogAction::RemoveParent {
                parent: parent.clone(),
            },
        )
    }

    pub fn add_owner(&self, change: &ChangeId, owner: &Identity) -> Result<()> {
        self.record(
            change,
            LogAction::AddOwner {
                owner: owner.clone(),
            },
        )
    }

    pub fn remove_owner(&self, change: &ChangeId, owner: &Identity) -> Result<()> {
        self.record(
            change,
            LogAction::RemoveOwner {
                owner: owner.clone(),
            },
        )
    }
}

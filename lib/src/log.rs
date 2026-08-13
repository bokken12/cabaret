use std::collections::BTreeSet;

use gix::Repository;
use serde::{Deserialize, Serialize};

use crate::{
    cabaret::Cabaret,
    error::Result,
    types::{Change, ChangeId, Identity, Revision, TimestampMs},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum LogAction {
    AddOwner { owner: Identity },
    AddParent { parent: ChangeId },
    RemoveOwner { owner: Identity },
    RemoveParent { parent: ChangeId },
    SetTitle { title: String },
}

// TODO-someday(joel): allow format evolution. protos? versioned?
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
    pub fn apply(&mut self, action: &LogAction) -> bool {
        match action {
            LogAction::AddOwner { owner } => self.owners.insert(owner.clone()),
            LogAction::AddParent { parent } => self.parents.insert(parent.clone()),
            LogAction::RemoveOwner { owner } => self.owners.remove(owner),
            LogAction::RemoveParent { parent } => self.parents.remove(parent),
            LogAction::SetTitle { title } => {
                let modified = self.title != *title;
                self.title.clone_from(title);
                modified
            }
        }
    }
}

const LOG_FILE: &str = "log.jsonl";

struct Log {
    head: Revision,
    text: String,
    change: Change,
}

impl Log {
    fn read(repo: &Repository, change: &ChangeId) -> Result<Self> {
        let log_ref = change.log_ref();
        let mut reference = repo.find_reference(&log_ref)?;
        let commit = reference.peel_to_commit()?;
        let tree = commit.tree()?;
        let entry = tree.find_entry(LOG_FILE).ok_or_else(|| format!("{} has no {LOG_FILE}", log_ref.as_bstr()))?;
        let blob = entry.object()?.try_into_blob()?;
        let text = std::str::from_utf8(&blob.data)?.to_owned();
        let mut change = Change::new(change);
        for line in text.lines() {
            let entry: LogEntry = serde_json::from_str(line)?;
            change.apply(&entry.action);
        }
        Ok(Self { head: Revision(commit.id), text, change })
    }
}

impl Cabaret {
    pub fn change(&self, change: &ChangeId) -> Result<Change> { Ok(Log::read(&self.repo, change)?.change) }

    fn record(&self, change: &ChangeId, action: LogAction) -> Result<()> {
        let mut log = Log::read(&self.repo, change)?;
        if !log.change.apply(&action) {
            return Ok(());
        }
        self.append(change, log, action)
    }

    fn append(&self, change: &ChangeId, log: Log, action: LogAction) -> Result<()> {
        let message = serde_json::to_string(&action)?;
        let entry = LogEntry { timestamp: TimestampMs::now(), action };
        let line = serde_json::to_string(&entry)?;
        let mut text = log.text;
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&line);
        text.push('\n');
        self.commit_log(change, &message, &text, [log.head])
    }

    fn commit_log(
        &self,
        change: &ChangeId,
        message: &str,
        text: &str,
        parents: impl IntoIterator<Item = Revision>,
    ) -> Result<()> {
        let blob = self.repo.write_blob(text.as_bytes())?;
        let tree = gix::objs::Tree {
            entries: vec![gix::objs::tree::Entry {
                mode: gix::objs::tree::EntryKind::Blob.into(),
                filename: LOG_FILE.into(),
                oid: blob.detach(),
            }],
        };
        let tree = self.repo.write_object(&tree)?;
        self.repo.commit(change.log_ref(), message, tree, parents)?;
        Ok(())
    }

    pub fn create_change(&self, change: &ChangeId, parent: &ChangeId) -> Result<()> {
        let tip = self.tip(parent)?;
        if self.repo.try_find_reference(&change.log_ref())?.is_some() {
            return Err(format!("{change} already exists").into());
        }
        if self.repo.try_find_reference(&change.branch_ref())?.is_some() {
            return Err(format!("branch {change} already exists").into());
        }

        let action = LogAction::AddParent { parent: parent.clone() };
        let message = serde_json::to_string(&action)?;
        let entry = LogEntry { timestamp: TimestampMs::now(), action };
        let mut text = serde_json::to_string(&entry)?;
        text.push('\n');
        // Committing with no parents demands the log ref not exist, closing the race above.
        self.commit_log(change, &message, &text, None)?;
        self.repo.reference(
            change.branch_ref(),
            tip,
            gix::refs::transaction::PreviousValue::MustNotExist,
            format!("create change {change}"),
        )?;
        Ok(())
    }

    pub fn add_parent(&self, change: &ChangeId, parent: &ChangeId) -> Result<()> {
        self.record(change, LogAction::AddParent { parent: parent.clone() })
    }

    pub fn remove_parent(&self, change: &ChangeId, parent: &ChangeId) -> Result<()> {
        self.record(change, LogAction::RemoveParent { parent: parent.clone() })
    }

    pub fn add_owner(&self, change: &ChangeId, owner: &Identity) -> Result<()> {
        self.record(change, LogAction::AddOwner { owner: owner.clone() })
    }

    pub fn remove_owner(&self, change: &ChangeId, owner: &Identity) -> Result<()> {
        self.record(change, LogAction::RemoveOwner { owner: owner.clone() })
    }

    pub fn set_parents(&self, change: &ChangeId, parents: &BTreeSet<ChangeId>) -> Result<()> {
        let current = self.change(change)?.parents;
        for parent in current.difference(parents) {
            self.remove_parent(change, parent)?;
        }
        for parent in parents.difference(&current) {
            self.add_parent(change, parent)?;
        }
        Ok(())
    }

    pub fn set_owners(&self, change: &ChangeId, owners: &BTreeSet<Identity>) -> Result<()> {
        let current = self.change(change)?.owners;
        for owner in current.difference(owners) {
            self.remove_owner(change, owner)?;
        }
        for owner in owners.difference(&current) {
            self.add_owner(change, owner)?;
        }
        Ok(())
    }
}

use std::collections::{BTreeMap, BTreeSet, btree_map};

use serde::{Deserialize, Serialize};

use crate::{
    cabaret::Cabaret,
    error::Result,
    revision::{Revision, RevisionRange},
    types::{ChangeId, Identity, Liveness, RepoPath, TimestampMs},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum LogAction {
    AddOwner { owner: Identity },
    AddParent { parent: ChangeId },
    Forget { user: Identity, file: RepoPath },
    Mark { user: Identity, file: RepoPath, range: RevisionRange },
    RemoveOwner { owner: Identity },
    RemoveParent { parent: ChangeId },
    SetDescription { description: Option<String> },
    SetLiveness { liveness: Liveness },
    SetTitle { title: Option<String> },
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

fn set<T: PartialEq + Clone>(place: &mut T, val: &T) -> bool {
    let changed = place != val;
    *place = val.clone();
    changed
}

fn set_key<K: Ord, T: PartialEq + Clone>(map: &mut BTreeMap<K, T>, k: K, val: &T) -> bool {
    match map.entry(k) {
        btree_map::Entry::Vacant(v) => {
            v.insert(val.clone());
            true
        }
        btree_map::Entry::Occupied(mut o) => set(o.get_mut(), val),
    }
}

fn remove_key<K: Ord, T>(map: &mut BTreeMap<K, T>, k: &K) -> bool { map.remove(k).is_some() }

/// A change's log: its stored form plus the fold of its actions.
// TODO-someday(joel): consider how to properly control lifecycle?
// TODO(joel: this should never have to cross the napi boundary
#[cfg_attr(feature = "napi", napi_derive::napi(object, object_from_js = false))]
pub struct Log {
    pub head: Revision,
    pub text: String,
    // TODO-someday(joel): add other relevant data
    pub title: Option<String>,
    pub description: Option<String>,
    pub liveness: Liveness,
    pub owners: BTreeSet<Identity>,
    pub parents: BTreeSet<ChangeId>,
    pub review_state: BTreeMap<Identity, BTreeMap<RepoPath, RevisionRange>>,
}

impl Log {
    /// `log.apply(action)` is `true` iff `action` modifies `log`.
    pub fn apply(&mut self, action: &LogAction) -> bool {
        match action {
            LogAction::AddOwner { owner } => self.owners.insert(owner.clone()),
            LogAction::AddParent { parent } => self.parents.insert(parent.clone()),
            LogAction::Forget { user, file } => remove_key(self.review_state.entry(user.clone()).or_default(), file),
            LogAction::Mark { user, file, range } => {
                set_key(self.review_state.entry(user.clone()).or_default(), file.clone(), range)
            }
            LogAction::RemoveOwner { owner } => self.owners.remove(owner),
            LogAction::RemoveParent { parent } => self.parents.remove(parent),
            LogAction::SetDescription { description } => set(&mut self.description, description),
            LogAction::SetLiveness { liveness } => set(&mut self.liveness, liveness),
            LogAction::SetTitle { title } => set(&mut self.title, title),
        }
    }
}

const LOG_FILE: &str = "log.jsonl";

impl Cabaret {
    pub fn log(&self, change: &ChangeId) -> Result<Log> {
        let log_ref = change.log_ref();
        let mut reference = self.repo.find_reference(&log_ref)?;
        let commit = reference.peel_to_commit()?;
        let tree = commit.tree()?;
        let entry = tree.find_entry(LOG_FILE).ok_or_else(|| format!("{} has no {LOG_FILE}", log_ref.as_bstr()))?;
        let blob = entry.object()?.try_into_blob()?;
        let text = std::str::from_utf8(&blob.data)?.to_owned();
        let entries: Vec<LogEntry> = text.lines().map(serde_json::from_str).collect::<serde_json::Result<_>>()?;
        let mut log = Log {
            head: Revision(commit.id),
            text,
            title: None,
            description: None,
            liveness: Liveness::Live,
            owners: BTreeSet::new(),
            parents: BTreeSet::new(),
            review_state: BTreeMap::new(),
        };
        for entry in &entries {
            log.apply(&entry.action);
        }
        Ok(log)
    }

    fn record(&self, change: &ChangeId, action: LogAction) -> Result<()> {
        let mut log = self.log(change)?;
        if !log.apply(&action) {
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

    pub fn create_change(&self, change: &ChangeId, parent: &ChangeId, owner: &Identity) -> Result<()> {
        let tip = self.tip(parent)?;
        if self.repo.try_find_reference(&change.log_ref())?.is_some() {
            return Err(format!("{change} already exists").into());
        }
        if self.repo.try_find_reference(&change.branch_ref())?.is_some() {
            return Err(format!("branch {change} already exists").into());
        }

        let actions = [LogAction::AddParent { parent: parent.clone() }, LogAction::AddOwner { owner: owner.clone() }];
        let mut message = String::new();
        let mut text = String::new();
        for action in actions {
            message.push_str(&serde_json::to_string(&action)?);
            message.push('\n');
            let entry = LogEntry { timestamp: TimestampMs::now(), action };
            text.push_str(&serde_json::to_string(&entry)?);
            text.push('\n');
        }
        // Committing with no parents demands the log ref not exist, closing the race above.
        self.commit_log(change, message.trim_end(), &text, None)?;
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

    pub fn set_description(&self, change: &ChangeId, description: Option<String>) -> Result<()> {
        self.record(change, LogAction::SetDescription { description })
    }

    pub fn set_liveness(&self, change: &ChangeId, liveness: Liveness) -> Result<()> {
        self.record(change, LogAction::SetLiveness { liveness })
    }

    pub fn set_owners(&self, change: &ChangeId, owners: &BTreeSet<Identity>) -> Result<()> {
        let current = self.log(change)?.owners;
        for owner in current.difference(owners) {
            self.remove_owner(change, owner)?;
        }
        for owner in owners.difference(&current) {
            self.add_owner(change, owner)?;
        }
        Ok(())
    }

    pub fn set_parents(&self, change: &ChangeId, parents: &BTreeSet<ChangeId>) -> Result<()> {
        let current = self.log(change)?.parents;
        for parent in current.difference(parents) {
            self.remove_parent(change, parent)?;
        }
        for parent in parents.difference(&current) {
            self.add_parent(change, parent)?;
        }
        Ok(())
    }

    pub fn set_title(&self, change: &ChangeId, title: Option<String>) -> Result<()> {
        self.record(change, LogAction::SetTitle { title })
    }
}

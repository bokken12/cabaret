use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::{
    change::Change,
    change_id::{ChangeId, ChangeIdRef},
    context::TransactionContext,
    error::Result,
    revision::{Revision, RevisionRange},
    types::{Identity, RepoPath, TimestampMs},
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
    SetArchived { archived: bool },
    SetDescription { description: Option<String> },
    SetPermanent { permanent: bool },
    SetTitle { title: Option<String> },
}

// TODO-someday(joel): allow format evolution. protos? versioned?
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: TimestampMs,
    pub user: Identity,
    #[serde(flatten)]
    pub action: LogAction,
}

const LOG_FILE: &str = "log.jsonl";

impl<'ctx> Change<'ctx> {
    /// Fold `change_id`'s log, up to `ctx.timestamp`.
    pub(crate) fn from_log(ctx: &'ctx TransactionContext<'ctx>, change_id: &ChangeIdRef) -> Result<Self> {
        let tip = Revision(ctx.repo.find_reference(&change_id.branch_ref())?.peel_to_commit()?.id);

        let log_ref = change_id.log_ref();
        let tree = ctx.repo.find_reference(&log_ref)?.peel_to_commit()?.tree()?;
        let entry = tree.find_entry(LOG_FILE).ok_or_else(|| format!("{} has no {LOG_FILE}", log_ref.as_bstr()))?;
        let blob = entry.object()?.try_into_blob()?;
        let text = std::str::from_utf8(&blob.data)?;

        let mut change = Change::new(ctx, change_id.to_owned(), tip);
        for line in text.lines() {
            let entry: LogEntry = serde_json::from_str(line)?;
            if entry.timestamp <= ctx.timestamp {
                change.apply(&entry.action);
            }
        }
        Ok(change)
    }

    fn apply(&mut self, action: &LogAction) {
        match action {
            LogAction::AddOwner { owner } => {
                self.owners.insert(owner.clone());
            }
            LogAction::AddParent { parent } => {
                self.parents.insert(parent.clone());
            }
            LogAction::Forget { user, file } => {
                self.review.entry(user.clone()).or_default().remove(file);
            }
            LogAction::Mark { user, file, range } => {
                self.review.entry(user.clone()).or_default().insert(file.clone(), range.clone());
            }
            LogAction::RemoveOwner { owner } => {
                self.owners.remove(owner);
            }
            LogAction::RemoveParent { parent } => {
                self.parents.remove(parent);
            }
            LogAction::SetArchived { archived } => self.archived = *archived,
            LogAction::SetDescription { description } => self.description = description.clone(),
            LogAction::SetPermanent { permanent } => self.permanent = *permanent,
            LogAction::SetTitle { title } => self.title = title.clone(),
        }
    }

    /// The actions that take `before` to `self`; empty when nothing changed.
    pub(crate) fn actions_since(&self, before: &Self) -> Vec<LogAction> {
        let mut actions = Vec::new();
        for owner in before.owners.difference(&self.owners) {
            actions.push(LogAction::RemoveOwner { owner: owner.clone() });
        }
        for owner in self.owners.difference(&before.owners) {
            actions.push(LogAction::AddOwner { owner: owner.clone() });
        }
        for parent in before.parents.difference(&self.parents) {
            actions.push(LogAction::RemoveParent { parent: parent.clone() });
        }
        for parent in self.parents.difference(&before.parents) {
            actions.push(LogAction::AddParent { parent: parent.clone() });
        }
        if self.archived != before.archived {
            actions.push(LogAction::SetArchived { archived: self.archived });
        }
        if self.permanent != before.permanent {
            actions.push(LogAction::SetPermanent { permanent: self.permanent });
        }
        if self.title != before.title {
            actions.push(LogAction::SetTitle { title: self.title.clone() });
        }
        if self.description != before.description {
            actions.push(LogAction::SetDescription { description: self.description.clone() });
        }
        // TODO(joel): diff `review` into Mark/Forget
        actions
    }
}

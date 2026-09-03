use gix::{
    ObjectId, Repository,
    objs::{
        Tree,
        tree::{Entry, EntryKind},
    },
    refs::{
        Target,
        transaction::{Change as RefChange, LogChange, PreviousValue, RefEdit, RefLog},
    },
};
use serde::{Deserialize, Serialize};

use crate::{
    change::Change,
    context::TransactionContext,
    error::Result,
    types::{ChangeId, ChangeIdRef, Identity, RepoPath, Revision, RevisionRange, TimestampMs, TreeId},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum LogAction {
    AddOwner { owner: Identity },
    AddParent { parent: ChangeId },
    Forget { file: RepoPath },
    Mark { file: RepoPath, range: RevisionRange },
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

fn read_log(repo: &Repository, commit: ObjectId) -> Result<String> {
    let tree = repo.find_commit(commit)?.tree()?;
    let entry = tree.find_entry(LOG_FILE).ok_or_else(|| format!("log commit {commit} has no {LOG_FILE}"))?;
    let blob = entry.object()?.try_into_blob()?;
    Ok(std::str::from_utf8(&blob.data)?.to_owned())
}

impl<'ctx> Change<'ctx> {
    /// Fold `change_id`'s log, up to `ctx.timestamp`.
    pub(crate) fn load(ctx: &'ctx TransactionContext<'ctx>, change_id: &ChangeIdRef) -> Result<Self> {
        let mut change = Change::new(ctx, change_id.to_owned(), ctx.branch_tip(change_id)?);
        let Some(log) = ctx.repo.try_find_reference(&change_id.log_ref())? else { return Ok(change) };
        let log_commit = log.into_fully_peeled_id()?.detach();
        change.log_commit = Some(log_commit);
        for line in read_log(&ctx.repo, log_commit)?.lines() {
            let entry: LogEntry = serde_json::from_str(line)?;
            if entry.timestamp <= ctx.timestamp {
                change.apply(&entry);
            }
        }
        Ok(change)
    }

    fn apply(&mut self, entry: &LogEntry) {
        match &entry.action {
            LogAction::AddOwner { owner } => {
                self.owners.insert(owner.clone());
            }
            LogAction::AddParent { parent } => {
                self.declared_parents.insert(parent.clone());
            }
            LogAction::Forget { file } => {
                self.review.entry(entry.user.clone()).or_default().remove(file);
            }
            LogAction::Mark { file, range } => {
                self.review.entry(entry.user.clone()).or_default().insert(file.clone(), range.clone());
            }
            LogAction::RemoveOwner { owner } => {
                self.owners.remove(owner);
            }
            LogAction::RemoveParent { parent } => {
                self.declared_parents.remove(parent);
            }
            LogAction::SetArchived { archived } => self.archived = *archived,
            LogAction::SetDescription { description } => self.description = description.clone(),
            LogAction::SetPermanent { permanent } => self.permanent = *permanent,
            LogAction::SetTitle { title } => self.title = title.clone(),
        }
    }

    /// Write `actions` onto this change's log as entries at `ctx.timestamp`, returning the ref edit
    /// that publishes them. The edit expects the log commit this change was read from, so a
    /// concurrent append fails rather than being overwritten.
    pub(crate) fn append(&self, actions: Vec<LogAction>) -> Result<RefEdit> {
        let ctx = self.ctx();
        let repo = &ctx.repo;
        let user = ctx.identity()?;
        let mut appended = String::new();
        for action in actions {
            let entry = LogEntry { timestamp: ctx.timestamp, user: user.clone(), action };
            appended.push_str(&serde_json::to_string(&entry)?);
            appended.push('\n');
        }
        let mut text = match self.log_commit {
            Some(commit) => read_log(repo, commit)?,
            None => String::new(),
        };
        text.push_str(&appended);

        let blob = repo.write_blob(text)?.detach();
        let entry = Entry { mode: EntryKind::Blob.into(), filename: LOG_FILE.into(), oid: blob };
        let tree = TreeId(repo.write_object(&Tree { entries: vec![entry] })?.detach());
        let commit = ctx.commit(tree, self.log_commit.into_iter().map(Revision).collect(), appended)?;

        Ok(RefEdit {
            change: RefChange::Update {
                log: LogChange {
                    mode: RefLog::AndReference,
                    force_create_reflog: false,
                    message: "cabaret: log".into(),
                },
                expected: match self.log_commit {
                    Some(previous) => PreviousValue::MustExistAndMatch(Target::Object(previous)),
                    None => PreviousValue::MustNotExist,
                },
                new: Target::Object(commit.0),
            },
            name: self.id().log_ref(),
            deref: false,
        })
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
        for parent in before.declared_parents.difference(&self.declared_parents) {
            actions.push(LogAction::RemoveParent { parent: parent.clone() });
        }
        for parent in self.declared_parents.difference(&before.declared_parents) {
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

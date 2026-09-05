//! The log each change's metadata is stored as: append-only entries behind a ref, folded on
//! read and merged by union across devices.

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
    error::Result,
    transaction::{context::TransactionContext, metadata::Metadata},
    types::{ChangeId, ChangeIdRef, Identity, RepoPath, Revision, RevisionRange, TimestampMs, TreeId},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum LogAction {
    AddOwner { owner: Identity },
    AddParent { parent: ChangeId },
    Forget { reviewer: Identity, file: RepoPath },
    Mark { reviewer: Identity, file: RepoPath, range: RevisionRange },
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

impl<'ctx> Metadata<'ctx> {
    /// Fold `id`'s log, up to `ctx.timestamp`.
    pub(crate) fn load(ctx: &'ctx TransactionContext<'ctx>, id: &ChangeIdRef) -> Result<Self> {
        let Some(reference) = ctx.repo.try_find_reference(&id.log_ref())? else {
            return Ok(Metadata::new(ctx, id.to_owned(), None));
        };
        let log_commit = reference.into_fully_peeled_id()?.detach();
        let mut metadata = Metadata::new(ctx, id.to_owned(), Some(log_commit));
        for line in read_log(&ctx.repo, log_commit)?.lines() {
            let entry: LogEntry = serde_json::from_str(line)?;
            if entry.timestamp <= ctx.timestamp {
                metadata.apply(&entry);
            }
        }
        Ok(metadata)
    }

    fn apply(&mut self, entry: &LogEntry) {
        match &entry.action {
            LogAction::AddOwner { owner } => {
                self.owners.insert(owner.clone());
            }
            LogAction::AddParent { parent } => {
                self.declared_parents.insert(parent.clone());
            }
            LogAction::Forget { reviewer, file } => {
                self.review.entry(reviewer.clone()).or_default().remove(file);
            }
            LogAction::Mark { reviewer, file, range } => {
                self.review.entry(reviewer.clone()).or_default().insert(file.clone(), range.clone());
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
        for (reviewer, files) in &before.review {
            let kept = |file: &RepoPath| self.review.get(reviewer).is_some_and(|files| files.contains_key(file));
            for file in files.keys().filter(|file| !kept(file)) {
                actions.push(LogAction::Forget { reviewer: reviewer.clone(), file: file.clone() });
            }
        }
        for (reviewer, files) in &self.review {
            let previous = |file: &RepoPath| before.review.get(reviewer).and_then(|files| files.get(file));
            for (file, range) in files.iter().filter(|(file, range)| previous(file) != Some(range)) {
                actions.push(LogAction::Mark { reviewer: reviewer.clone(), file: file.clone(), range: range.clone() });
            }
        }
        actions
    }

    /// Write `actions` onto this log as entries at `ctx.timestamp`, returning the ref edit that
    /// publishes them. The edit expects the log commit this was read from, so a concurrent append
    /// fails rather than being overwritten.
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
        let mut text = match self.log_commit() {
            Some(commit) => read_log(repo, commit)?,
            None => String::new(),
        };
        text.push_str(&appended);

        let blob = repo.write_blob(text)?.detach();
        let entry = Entry { mode: EntryKind::Blob.into(), filename: LOG_FILE.into(), oid: blob };
        let tree = TreeId(repo.write_object(&Tree { entries: vec![entry] })?.detach());
        let commit = ctx.commit(tree, self.log_commit().into_iter().map(Revision).collect(), appended)?;

        Ok(RefEdit {
            change: RefChange::Update {
                log: LogChange {
                    mode: RefLog::AndReference,
                    force_create_reflog: false,
                    message: "cabaret: log".into(),
                },
                expected: match self.log_commit() {
                    Some(previous) => PreviousValue::MustExistAndMatch(Target::Object(previous)),
                    None => PreviousValue::MustNotExist,
                },
                new: Target::Object(commit.0),
            },
            name: self.id().log_ref(),
            deref: false,
        })
    }
}

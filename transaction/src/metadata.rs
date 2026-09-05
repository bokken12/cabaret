//! What Cabaret knows about a change beyond where its branch points. Stored as a log behind a
//! ref, see [`cabaret_types::log`], which is a fact about storage rather than about the metadata.

use std::collections::{BTreeMap, BTreeSet};

use cabaret_types::{
    ChangeId, ChangeIdRef, Identity, RepoPath, Result, Revision, RevisionRange,
    log::{self, LogAction, LogEntry},
};
use gix::{
    ObjectId,
    refs::{
        Target,
        transaction::{Change as RefChange, LogChange, PreviousValue, RefEdit, RefLog},
    },
};

use crate::context::TransactionContext;

/// A change's metadata as of one instant: everything about it except where its branch points.
#[derive(Clone, Debug)]
pub struct Metadata<'ctx> {
    ctx: &'ctx TransactionContext<'ctx>,
    id: ChangeId,
    log_commit: Option<ObjectId>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub archived: bool,
    pub permanent: bool,
    pub owners: BTreeSet<Identity>,
    pub declared_parents: BTreeSet<ChangeId>,
    pub review: BTreeMap<Identity, BTreeMap<RepoPath, RevisionRange>>,
}

impl<'ctx> Metadata<'ctx> {
    /// Empty metadata, as folded from `log_commit` before any entries are applied.
    pub fn new(ctx: &'ctx TransactionContext<'ctx>, id: ChangeId, log_commit: Option<ObjectId>) -> Self {
        Self {
            ctx,
            id,
            log_commit,
            title: None,
            description: None,
            archived: false,
            permanent: false,
            owners: BTreeSet::new(),
            declared_parents: BTreeSet::new(),
            review: BTreeMap::new(),
        }
    }

    pub fn ctx(&self) -> &'ctx TransactionContext<'ctx> { self.ctx }

    pub fn id(&self) -> &ChangeIdRef { &self.id }

    /// The log commit this state was folded from; `None` before the change's first write.
    pub fn log_commit(&self) -> Option<ObjectId> { self.log_commit }

    pub fn is_descendant(&self, ancestor: &ChangeIdRef) -> Result<bool> {
        if ancestor == self.id.as_ref() {
            return Ok(true);
        }
        self.declared_parents
            .iter()
            .try_fold(false, |acc, parent| Ok(acc || self.ctx.metadata(parent)?.is_descendant(ancestor)?))
    }

    pub fn is_ancestor(&self, descendant: &ChangeIdRef) -> Result<bool> {
        self.ctx.metadata(descendant)?.is_descendant(&self.id)
    }

    /// The changes this one actually targets: declared parents, or the default branch when none
    /// are declared, with archived ones replaced by their own parents.
    // TODO-someday(joel): store computed parents?
    pub fn parents(&self) -> Result<BTreeSet<ChangeId>> {
        if self.archived {
            return Ok(self.declared_parents.clone());
        }

        let mut candidates = BTreeSet::new();
        let mut frontier: Vec<_> = self.declared_parents.iter().cloned().collect();
        if frontier.is_empty() {
            let default = self.ctx.default_branch()?;
            if default != self.id {
                frontier.push(default);
            }
        }
        while let Some(candidate_id) = frontier.pop() {
            let candidate = self.ctx.metadata(&candidate_id)?;
            // skip archived parents and land into their parents
            if candidate.archived {
                frontier.extend(candidate.declared_parents.iter().cloned());
            } else {
                candidates.insert(candidate_id);
            }
        }
        self.ctx.maximal_changes(&candidates)
    }

    /// Fold `id`'s log, up to `ctx.timestamp`.
    pub fn load(ctx: &'ctx TransactionContext<'ctx>, id: &ChangeIdRef) -> Result<Self> {
        let Some(reference) = ctx.repo.try_find_reference(&id.log_ref())? else {
            return Ok(Metadata::new(ctx, id.to_owned(), None));
        };
        let log_commit = reference.into_fully_peeled_id()?.detach();
        let mut metadata = Metadata::new(ctx, id.to_owned(), Some(log_commit));
        for entry in log::read(&ctx.repo, log_commit)? {
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
    pub fn actions_since(&self, before: &Self) -> Vec<LogAction> {
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
    pub fn append(&self, actions: Vec<LogAction>) -> Result<RefEdit> {
        let ctx = self.ctx();
        let user = ctx.identity()?;
        let entries: Vec<LogEntry> = actions
            .into_iter()
            .map(|action| LogEntry { timestamp: ctx.timestamp, user: user.clone(), action })
            .collect();
        let appended = log::render(&entries)?;
        let tree = log::write(&ctx.repo, self.log_commit(), &appended)?;
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

impl<'ctx> TransactionContext<'ctx> {
    /// `changes` without any that is an ancestor of another of them.
    pub fn maximal_changes(&'ctx self, changes: &BTreeSet<ChangeId>) -> Result<BTreeSet<ChangeId>> {
        let mut candidates = changes.clone();

        for candidate_id in changes {
            let candidate = self.metadata(candidate_id)?;
            for other in &candidates {
                if candidate_id != other && candidate.is_ancestor(other)? {
                    candidates.remove(candidate_id);
                    break;
                }
            }
        }

        Ok(candidates)
    }
}

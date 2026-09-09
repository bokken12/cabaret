//! What Cabaret knows about a change beyond where its branch points. Stored behind a ref as a
//! commit holding a log, see [`cabaret_types::log`], beside the description as a file of its own
//! so git merges edits to it; both are facts about storage rather than about the metadata.

use std::collections::{BTreeMap, BTreeSet};

use cabaret_types::{
    ChangeId, ChangeIdRef, Identity, RepoPath, Result, RevisionId, TreeId,
    log::{self, LogAction, LogEntry},
};
use gix::{
    ObjectId, Tree,
    objs::tree::{Entry, EntryKind},
    refs::{
        Target,
        transaction::{Change as RefChange, LogChange, PreviousValue, RefEdit, RefLog},
    },
};

use crate::context::TransactionContext;

const LOG_FILE: &str = "log.jsonl";
/// Always present, empty for no description, so that a description folded from an old log (see
/// `LogAction::SetDescription`) is overridden even by clearing it.
const DESCRIPTION_FILE: &str = "description.md";

/// The text of `name` in `tree`, or `None` when no file is there.
fn file(tree: &Tree<'_>, name: &str) -> Result<Option<String>> {
    let Some(entry) = tree.find_entry(name) else { return Ok(None) };
    let mut blob = entry.object()?.try_into_blob()?;
    Ok(Some(String::from_utf8(blob.take_data())?))
}

/// The log in a metadata commit's `tree`, which every one holds.
fn log(tree: &Tree<'_>) -> Result<String> {
    file(tree, LOG_FILE)?.ok_or_else(|| format!("metadata tree {} has no {LOG_FILE}", tree.id).into())
}

/// A change's metadata as of one instant: everything about it except where its branch points.
#[derive(Clone, Debug)]
pub struct Metadata<'ctx> {
    ctx: &'ctx TransactionContext<'ctx>,
    id: ChangeId,
    commit: Option<ObjectId>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub archived: bool,
    pub permanent: bool,
    pub owners: BTreeSet<Identity>,
    pub declared_parents: BTreeSet<ChangeId>,
    pub review: BTreeMap<Identity, BTreeMap<RepoPath, RevisionId>>,
}

impl<'ctx> Metadata<'ctx> {
    /// Empty metadata, as read from `commit` before anything in it is applied.
    pub fn new(ctx: &'ctx TransactionContext<'ctx>, id: ChangeId, commit: Option<ObjectId>) -> Self {
        Self {
            ctx,
            id,
            commit,
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

    /// The commit this state was read from; `None` before the change's first write.
    pub fn commit(&self) -> Option<ObjectId> { self.commit }

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

    /// Fold `id`'s log, up to `ctx.timestamp`, and read its description.
    pub fn load(ctx: &'ctx TransactionContext<'ctx>, id: &ChangeIdRef) -> Result<Self> {
        let Some(reference) = ctx.repo.try_find_reference(&id.log_ref())? else {
            return Ok(Metadata::new(ctx, id.to_owned(), None));
        };
        let commit = reference.into_fully_peeled_id()?.detach();
        let tree = ctx.repo.find_commit(commit)?.tree()?;
        let mut metadata = Metadata::new(ctx, id.to_owned(), Some(commit));
        for entry in log::parse(&log(&tree)?)? {
            if entry.timestamp <= ctx.timestamp {
                metadata.apply(&entry);
            }
        }
        if let Some(description) = file(&tree, DESCRIPTION_FILE)? {
            metadata.description = Some(description).filter(|text| !text.is_empty());
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
            LogAction::Mark { reviewer, file, revision } => {
                self.review.entry(reviewer.clone()).or_default().insert(file.clone(), revision.clone());
            }
            LogAction::RemoveOwner { owner } => {
                self.owners.remove(owner);
            }
            LogAction::RemoveParent { parent } => {
                self.declared_parents.remove(parent);
            }
            LogAction::SetArchived { archived } => self.archived = *archived,
            // superseded by the description file once one is written, see `DESCRIPTION_FILE`
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
        for (reviewer, files) in &before.review {
            let kept = |file: &RepoPath| self.review.get(reviewer).is_some_and(|files| files.contains_key(file));
            for file in files.keys().filter(|file| !kept(file)) {
                actions.push(LogAction::Forget { reviewer: reviewer.clone(), file: file.clone() });
            }
        }
        for (reviewer, files) in &self.review {
            let previous = |file: &RepoPath| before.review.get(reviewer).and_then(|files| files.get(file));
            for (file, revision) in files.iter().filter(|(file, revision)| previous(file) != Some(revision)) {
                actions.push(LogAction::Mark {
                    reviewer: reviewer.clone(),
                    file: file.clone(),
                    revision: revision.clone(),
                });
            }
        }
        actions
    }

    /// Write how this differs from `before` as a commit on the one this was read from: the actions
    /// (see [`Self::actions_since`]) appended to the log at `ctx.timestamp`, and the description
    /// as it now is. Returns the ref edit that publishes it, or `None` when nothing changed. The
    /// edit expects the commit this was read from, so a concurrent write fails rather than being
    /// overwritten.
    pub fn write_since(&self, before: &Self) -> Result<Option<RefEdit>> {
        let actions = self.actions_since(before);
        let described = self.description != before.description;
        if actions.is_empty() && !described {
            return Ok(None);
        }

        let ctx = self.ctx();
        let repo = &ctx.repo;
        let user = ctx.identity()?;
        let entries: Vec<LogEntry> = actions
            .into_iter()
            .map(|action| LogEntry { timestamp: ctx.timestamp, user: user.clone(), action })
            .collect();
        let appended = log::render(&entries)?;
        let mut text = match self.commit {
            Some(commit) => log(&repo.find_commit(commit)?.tree()?)?,
            None => String::new(),
        };
        text.push_str(&appended);
        let description = self.description.as_deref().unwrap_or("");
        let mut entries = vec![
            Entry { mode: EntryKind::Blob.into(), filename: LOG_FILE.into(), oid: repo.write_blob(text)?.detach() },
            Entry {
                mode: EntryKind::Blob.into(),
                filename: DESCRIPTION_FILE.into(),
                oid: repo.write_blob(description)?.detach(),
            },
        ];
        entries.sort();
        let tree = TreeId(repo.write_object(&gix::objs::Tree { entries })?.detach());

        let mut message = appended;
        if described {
            message.push_str("edit description\n");
        }
        let commit = ctx.commit(tree, self.commit.into_iter().map(RevisionId).collect(), message)?;

        Ok(Some(RefEdit {
            change: RefChange::Update {
                log: LogChange {
                    mode: RefLog::AndReference,
                    force_create_reflog: false,
                    message: "cabaret: metadata".into(),
                },
                expected: match self.commit {
                    Some(previous) => PreviousValue::MustExistAndMatch(Target::Object(previous)),
                    None => PreviousValue::MustNotExist,
                },
                new: Target::Object(commit.0),
            },
            name: self.id().log_ref(),
            deref: false,
        }))
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

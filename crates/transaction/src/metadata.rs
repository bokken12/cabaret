//! What Cabaret knows about a change beyond where its branch points. Stored behind a ref as a
//! graph of commits each holding one write's actions, see [`cabaret_types::log`], beside the
//! description as a file of its own so git merges edits to it; both are facts about storage
//! rather than about the metadata.

use std::collections::{BTreeMap, BTreeSet, btree_map};

use cabaret_types::{
    ChangeId, ChangeIdRef, Identity, RepoPath, Result, RevisionId, TimestampS, TreeId,
    log::{self, LogAction},
};
use gix::{
    ObjectId, Repository, Tree,
    diff::blob::InternedInput,
    merge::blob::builtin_driver::{
        self,
        text::{Conflict, ConflictStyle, Labels, Options},
    },
    objs::tree::{Entry, EntryKind},
    refs::{
        Target,
        transaction::{Change as RefChange, LogChange, PreviousValue, RefEdit, RefLog},
    },
};

use crate::context::TransactionContext;

const ACTIONS_FILE: &str = "actions.jsonl";
/// Always present, empty for no description, so clearing it on one device while editing it on
/// another merges as a text conflict rather than a modify/delete one.
const DESCRIPTION_FILE: &str = "description.md";

/// The text of `name` in `tree`, or `None` when no file is there.
fn file(tree: &Tree<'_>, name: &str) -> Result<Option<String>> {
    let Some(entry) = tree.find_entry(name) else { return Ok(None) };
    let mut blob = entry.object()?.try_into_blob()?;
    Ok(Some(String::from_utf8(blob.take_data())?))
}

/// One commit of a log: the actions it took, and the log commits it was written on.
struct LogCommit {
    time: TimestampS,
    parents: Vec<ObjectId>,
    actions: Vec<LogAction>,
}

impl LogCommit {
    /// Every parent of a log commit is another log commit except the revisions its actions refer
    /// to, see [`LogAction::revision`].
    fn read(repo: &Repository, id: ObjectId) -> Result<Self> {
        let commit = repo.find_commit(id)?;
        let text =
            file(&commit.tree()?, ACTIONS_FILE)?.ok_or_else(|| format!("log commit {id} has no {ACTIONS_FILE}"))?;
        let actions = log::parse(&text)?;
        let referenced: BTreeSet<ObjectId> =
            actions.iter().filter_map(LogAction::revision).map(ObjectId::from).collect();
        let parents: Vec<ObjectId> = commit.parent_ids().map(gix::Id::detach).collect();
        if let Some(missing) = referenced.iter().find(|revision| !parents.contains(revision)) {
            Err(format!("log commit {id} refers to {missing} without taking it as a parent"))?;
        }
        let parents = parents.into_iter().filter(|parent| !referenced.contains(parent)).collect();
        Ok(Self { time: commit.time()?.seconds, parents, actions })
    }
}

// TODO-someday(joel): every read folds the whole log. Materialize the state, stored on each log
// commit or cached locally by head, and extend it by replaying only the commits after the latest
// one that every other commit is an ancestor or descendant of, where the fold order agrees.
/// Every commit of the log ending at `head`, by id.
fn commits(repo: &Repository, head: ObjectId) -> Result<BTreeMap<ObjectId, LogCommit>> {
    let mut commits = BTreeMap::new();
    let mut frontier = vec![head];
    while let Some(id) = frontier.pop() {
        if let btree_map::Entry::Vacant(slot) = commits.entry(id) {
            frontier.extend(&slot.insert(LogCommit::read(repo, id)?).parents);
        }
    }
    Ok(commits)
}

/// Every action of the log ending at `head`, each after all those its commit was written on.
/// Commits written without seeing each other go in time order, ties broken by id, so that every
/// device folds the same log alike.
fn actions(repo: &Repository, head: ObjectId) -> Result<Vec<LogAction>> {
    let mut commits = commits(repo, head)?;

    let mut children: BTreeMap<ObjectId, Vec<ObjectId>> = BTreeMap::new();
    for (id, commit) in &commits {
        for parent in &commit.parents {
            children.entry(*parent).or_default().push(*id);
        }
    }
    let mut unfolded_parents: BTreeMap<ObjectId, usize> =
        commits.iter().map(|(id, commit)| (*id, commit.parents.len())).collect();
    let mut ready: BTreeSet<(TimestampS, ObjectId)> =
        commits.iter().filter(|(_, commit)| commit.parents.is_empty()).map(|(id, commit)| (commit.time, *id)).collect();
    let mut actions = Vec::new();
    while let Some((_, id)) = ready.pop_first() {
        actions.extend(commits.remove(&id).expect("each commit is ready once").actions);
        for child in children.remove(&id).into_iter().flatten() {
            let unfolded = unfolded_parents.get_mut(&child).expect("every child is a commit of the log");
            *unfolded -= 1;
            if *unfolded == 0 {
                ready.insert((commits[&child].time, child));
            }
        }
    }
    assert!(commits.is_empty(), "every commit of a log is folded");
    Ok(actions)
}

/// A log commit's tree: `actions` and the description as it then is.
fn write_tree(repo: &Repository, actions: &str, description: &str) -> Result<TreeId> {
    let mut entries = vec![
        Entry { mode: EntryKind::Blob.into(), filename: ACTIONS_FILE.into(), oid: repo.write_blob(actions)?.detach() },
        Entry {
            mode: EntryKind::Blob.into(),
            filename: DESCRIPTION_FILE.into(),
            oid: repo.write_blob(description)?.detach(),
        },
    ];
    entries.sort();
    Ok(TreeId(repo.write_object(&gix::objs::Tree { entries })?.detach()))
}

/// The description as the log commit `id` has it, empty for none.
fn description(repo: &Repository, id: ObjectId) -> Result<String> {
    Ok(file(&repo.find_commit(id)?.tree()?, DESCRIPTION_FILE)?.unwrap_or_default())
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

    /// Fold `id`'s log and read its description.
    pub fn load(ctx: &'ctx TransactionContext<'ctx>, id: &ChangeIdRef) -> Result<Self> {
        let Some(reference) = ctx.repo.try_find_reference(&id.log_ref())? else {
            return Ok(Metadata::new(ctx, id.to_owned(), None));
        };
        let commit = reference.into_fully_peeled_id()?.detach();
        let tree = ctx.repo.find_commit(commit)?.tree()?;
        let mut metadata = Metadata::new(ctx, id.to_owned(), Some(commit));
        for action in actions(&ctx.repo, commit)? {
            metadata.apply(&action);
        }
        metadata.description = file(&tree, DESCRIPTION_FILE)?.filter(|text| !text.is_empty());
        Ok(metadata)
    }

    fn apply(&mut self, action: &LogAction) {
        match action {
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
                self.review.entry(reviewer.clone()).or_default().insert(file.clone(), *revision);
            }
            LogAction::RemoveOwner { owner } => {
                self.owners.remove(owner);
            }
            LogAction::RemoveParent { parent } => {
                self.declared_parents.remove(parent);
            }
            LogAction::SetArchived { archived } => self.archived = *archived,
            LogAction::SetPermanent { permanent } => self.permanent = *permanent,
            LogAction::SetTitle { title } => self.title.clone_from(title),
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
                actions.push(LogAction::Mark { reviewer: reviewer.clone(), file: file.clone(), revision: *revision });
            }
        }
        actions
    }

    /// Write how this differs from `before` as a commit on the one this was read from: the actions
    /// (see [`Self::actions_since`]), and the description as it now is. Returns the ref edit that
    /// publishes it, or `None` when nothing changed. The edit expects the commit this was read
    /// from, so a concurrent write fails rather than being overwritten.
    pub fn write_since(&self, before: &Self) -> Result<Option<RefEdit>> {
        let actions = self.actions_since(before);
        let described = self.description != before.description;
        if actions.is_empty() && !described {
            return Ok(None);
        }

        let ctx = self.ctx();
        let text = log::render(&actions)?;
        let tree = write_tree(&ctx.repo, &text, self.description.as_deref().unwrap_or(""))?;

        let referenced: BTreeSet<RevisionId> = actions.iter().filter_map(LogAction::revision).collect();
        let parents = self.commit.map(RevisionId).into_iter().chain(referenced).collect();
        let mut message = text;
        if described {
            message.push_str("edit description\n");
        }
        let commit = ctx.commit(tree, parents, message)?;
        Ok(Some(self.edit(commit.0, "cabaret: metadata")))
    }

    /// The ref edit taking this change's log to one that has seen origin's, as last fetched:
    /// `None` when it already has, origin's itself when that has seen all of this one, else a
    /// merge of the two. The edit expects the commit this was read from, so a concurrent write
    /// fails rather than being overwritten.
    pub fn merge_origin(&self) -> Result<Option<RefEdit>> {
        let repo = &self.ctx.repo;
        let other = repo.find_reference(&self.id().origin_log_ref())?.peel_to_id()?.detach();
        let Some(local) = self.commit else { return Ok(Some(self.edit(other, "cabaret: fetch"))) };
        let ours = commits(repo, local)?;
        if ours.contains_key(&other) {
            return Ok(None);
        }
        let theirs = commits(repo, other)?;
        let head = match theirs.contains_key(&local) {
            true => other,
            false => self.merge_commit(local, &ours, other, &theirs)?,
        };
        Ok(Some(self.edit(head, "cabaret: fetch")))
    }

    /// A log commit on `local` and `other`, given `ours` and `theirs`, the commits of each. It
    /// takes no actions of its own, as folding orders both sides' already, and merges their
    /// descriptions, keeping conflicts as text, from that of the latest commit both have seen.
    /// Only crossed merges leave several such commits, so taking the latest in fold order will do.
    fn merge_commit(
        &self,
        local: ObjectId,
        ours: &BTreeMap<ObjectId, LogCommit>,
        other: ObjectId,
        theirs: &BTreeMap<ObjectId, LogCommit>,
    ) -> Result<ObjectId> {
        let ctx = self.ctx;
        let repo = &ctx.repo;
        // Both have seen everything before a commit both have seen, so the latest are those no
        // other common commit was written on.
        let common: BTreeMap<_, _> = ours.iter().filter(|(id, _)| theirs.contains_key(*id)).collect();
        let seen: BTreeSet<_> = common.values().flat_map(|commit| &commit.parents).collect();
        let base = common
            .iter()
            .filter(|(id, _)| !seen.contains(**id))
            .max_by_key(|(id, commit)| (commit.time, ***id))
            .map(|(id, _)| **id);

        let author = |id: ObjectId| -> Result<String> { Ok(repo.find_commit(id)?.author()?.email.to_string()) };
        let (local_author, other_author) = (author(local)?, author(other)?);
        let labels = Labels {
            ancestor: Some("base".into()),
            current: Some(local_author.as_str().into()),
            other: Some(other_author.as_str().into()),
        };
        let (current, other_description) = (description(repo, local)?, description(repo, other)?);
        let ancestor = match base {
            Some(base) => description(repo, base)?,
            None => String::new(),
        };
        // Diff3 shows what both sides changed from, which a reader resolving it needs.
        let conflict = Conflict::Keep {
            style: ConflictStyle::Diff3,
            marker_size: Conflict::DEFAULT_MARKER_SIZE.try_into().expect("the default marker size is non-zero"),
        };
        let options = Options { conflict, ..Default::default() };
        let mut merged = Vec::new();
        let mut input = InternedInput::new(&[][..], &[][..]);
        builtin_driver::text(
            &mut merged,
            &mut input,
            labels,
            current.as_bytes(),
            ancestor.as_bytes(),
            other_description.as_bytes(),
            options,
        );

        let tree = write_tree(repo, "", &String::from_utf8(merged)?)?;
        Ok(ctx.commit(tree, vec![RevisionId(local), RevisionId(other)], "merge\n")?.0)
    }

    /// The edit moving this change's log ref from the commit this was read from to `new`.
    fn edit(&self, new: ObjectId, message: &str) -> RefEdit {
        RefEdit {
            change: RefChange::Update {
                log: LogChange { mode: RefLog::AndReference, force_create_reflog: false, message: message.into() },
                expected: match self.commit {
                    Some(previous) => PreviousValue::MustExistAndMatch(Target::Object(previous)),
                    None => PreviousValue::MustNotExist,
                },
                new: Target::Object(new),
            },
            name: self.id().log_ref(),
            deref: false,
        }
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

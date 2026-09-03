use std::fmt;

use elsa::FrozenBTreeMap;
use gix::{
    Repository,
    bstr::{BString, ByteSlice},
    objs::Commit,
    refs::TargetRef,
};

use crate::{
    change::Change,
    error::Result,
    types::{ChangeId, ChangeIdRef, Identity, RepoPath, Revision, TimestampMs, TreeId},
};

/// One transaction's view of the repository at a fixed time
pub struct TransactionContext<'ctx> {
    pub(crate) repo: Repository,
    pub timestamp: TimestampMs,
    read: FrozenBTreeMap<ChangeId, Box<Change<'ctx>>>,
}

impl<'ctx> fmt::Debug for TransactionContext<'ctx> {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result { todo!() }
}

impl<'ctx> TransactionContext<'ctx> {
    pub(crate) fn new(repo: Repository) -> Self {
        Self { repo, timestamp: TimestampMs::now(), read: FrozenBTreeMap::new() }
    }

    /// The state of `change_id` as of `self.timestamp`.
    pub fn read(&'ctx self, change_id: &ChangeIdRef) -> Result<&'ctx Change<'ctx>> {
        if let Some(change) = self.read.get(change_id) {
            return Ok(change);
        }

        let change = Change::load(self, change_id)?;
        Ok(self.read.insert(change_id.to_owned(), Box::new(change)))
    }

    /// Every local branch is a change, whether or not anything has been logged about it.
    pub fn changes(&self) -> Result<Vec<ChangeId>> {
        let mut changes = Vec::new();
        for reference in self.repo.references()?.local_branches()? {
            changes.push(reference?.name().shorten().to_str()?.parse()?);
        }
        Ok(changes)
    }

    /// The branch changes target unless told otherwise: origin's HEAD, or without one whichever of
    /// `main` and `master` exists.
    pub fn default_branch(&self) -> Result<ChangeId> {
        if let Some(head) = self.repo.try_find_reference("refs/remotes/origin/HEAD")? {
            let TargetRef::Symbolic(target) = head.target() else { Err("origin/HEAD is not symbolic")? };
            let branch =
                target.as_bstr().strip_prefix(b"refs/remotes/origin/").ok_or("origin/HEAD is not on origin")?;
            return Ok(branch.to_str()?.parse()?);
        }
        let mut candidates = Vec::new();
        for name in ["main", "master"] {
            let branch: ChangeId = name.parse()?;
            if self.repo.try_find_reference(&branch.branch_ref())?.is_some() {
                candidates.push(branch);
            }
        }
        match candidates.as_slice() {
            [branch] => Ok(branch.clone()),
            [] => Err("no origin/HEAD, main, or master to be the default branch")?,
            [_, _, ..] => Err("both main and master exist; set origin/HEAD to pick the default branch")?,
        }
    }

    /// The commit `spec` names, in git's revision syntax.
    pub fn resolve(&self, spec: &str) -> Result<Revision> {
        Ok(Revision(self.repo.rev_parse_single(spec)?.object()?.peel_to_commit()?.id))
    }

    pub fn branch_tip(&self, change_id: &ChangeIdRef) -> Result<Revision> {
        Ok(Revision(self.repo.find_reference(&change_id.branch_ref())?.peel_to_commit()?.id))
    }

    /// The identity this repository acts as: git's user.email.
    pub fn identity(&self) -> Result<Identity> {
        let committer = self.repo.committer().ok_or("no git identity; set user.email")??;
        Ok(Identity(committer.email.to_string()))
    }

    /// Write a commit of `tree` on `parents` as this repository's identity, without moving any ref.
    pub fn commit(&self, tree: TreeId, parents: Vec<Revision>, message: impl Into<BString>) -> Result<Revision> {
        let committer = self.repo.committer().ok_or("no git identity; set user.email")??.to_owned()?;
        let commit = Commit {
            tree: tree.0,
            parents: parents.into_iter().map(Into::into).collect(),
            author: committer.clone(),
            committer,
            encoding: None,
            message: message.into(),
            extra_headers: Vec::new(),
        };
        Ok(Revision(self.repo.write_object(&commit)?.detach()))
    }

    // TODO-someday(joel): consider pulling into state
    pub fn current_change(&self) -> Result<ChangeId> {
        let head = self.repo.head_name()?.ok_or("HEAD is detached")?;
        Ok(head.shorten().to_string().parse()?)
    }

    /// The text of `path` at `revision`, or `None` when no file is there.
    // TODO-someday(joel): binary files
    pub fn blob(&self, revision: Revision, path: &RepoPath) -> Result<Option<String>> {
        let tree = self.repo.find_commit(revision.0)?.tree()?;
        let Some(entry) = tree.lookup_entry_by_path(path.as_ref())? else { return Ok(None) };
        let mut blob = entry.object()?.try_into_blob()?;
        Ok(Some(String::from_utf8(blob.take_data())?))
    }
}

use std::{collections::BTreeSet, fmt};

use cabaret_types::{
    ChangeId, ChangeIdRef, ChangeSnapshot, Identity, RepoPath, Result, Revision, TimestampMs, TreeId, WorkspaceId,
    WorkspaceIdRef,
};
use elsa::FrozenBTreeMap;
use gix::{
    Repository,
    bstr::{BString, ByteSlice},
    lock::Marker,
    objs::Commit,
    refs::TargetRef,
};

use crate::{branch::Branch, metadata::Metadata, workspace::Workspace};

// TODO-someday(joel): rename `TransactionContext` -> `Transaction`?
/// One transaction's view of the repository at a fixed time, holding its resources' locks
pub struct TransactionContext<'ctx> {
    pub repo: Repository,
    pub timestamp: TimestampMs,
    metadata: FrozenBTreeMap<ChangeId, Box<Metadata<'ctx>>>,
    branches: FrozenBTreeMap<ChangeId, Box<Branch<'ctx>>>,
    workspaces: FrozenBTreeMap<WorkspaceId, Box<Workspace<'ctx>>>,
    _locks: Vec<Marker>,
}

impl fmt::Debug for TransactionContext<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TransactionContext")
            .field("git_dir", &self.repo.git_dir())
            .field("timestamp", &self.timestamp)
            .finish_non_exhaustive()
    }
}

impl<'ctx> TransactionContext<'ctx> {
    pub fn new(repo: Repository, locks: Vec<Marker>) -> Self {
        Self {
            repo,
            timestamp: TimestampMs::now(),
            metadata: FrozenBTreeMap::new(),
            branches: FrozenBTreeMap::new(),
            workspaces: FrozenBTreeMap::new(),
            _locks: locks,
        }
    }

    /// `change_id`'s metadata as committed, folded up to `self.timestamp`.
    pub fn metadata(&'ctx self, change_id: &ChangeIdRef) -> Result<&'ctx Metadata<'ctx>> {
        if let Some(metadata) = self.metadata.get(change_id) {
            return Ok(metadata);
        }
        Ok(self.metadata.insert(change_id.to_owned(), Box::new(Metadata::load(self, change_id)?)))
    }

    /// `change_id`'s branch as committed when first asked for.
    pub fn branch(&'ctx self, change_id: &ChangeIdRef) -> Result<&'ctx Branch<'ctx>> {
        if let Some(branch) = self.branches.get(change_id) {
            return Ok(branch);
        }
        Ok(self.branches.insert(change_id.to_owned(), Box::new(Branch::load(self, change_id)?)))
    }

    /// `workspace_id`'s workspace as committed when first asked for.
    pub fn workspace(&'ctx self, workspace_id: WorkspaceIdRef<'_>) -> Result<&'ctx Workspace<'ctx>> {
        if let Some(workspace) = self.workspaces.get(&workspace_id.into_owned()) {
            return Ok(workspace);
        }
        Ok(self.workspaces.insert(workspace_id.into_owned(), Box::new(Workspace::load(self, workspace_id)?)))
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

    pub fn current_change(&'ctx self) -> Result<ChangeId> {
        Ok(self.workspace(self.current_workspace()?.to_ref())?.change().ok_or("HEAD is detached")?.clone())
    }

    /// The text of `path` at `revision`, or `None` when no file is there.
    // TODO-someday(joel): binary files
    pub fn blob(&self, revision: Revision, path: &RepoPath) -> Result<Option<String>> {
        let tree = self.repo.find_commit(revision.0)?.tree()?;
        let Some(entry) = tree.lookup_entry_by_path(path.as_ref())? else { return Ok(None) };
        let mut blob = entry.object()?.try_into_blob()?;
        Ok(Some(String::from_utf8(blob.take_data())?))
    }

    pub fn snapshot(&'ctx self, change_id: &ChangeIdRef) -> Result<ChangeSnapshot> {
        let (metadata, branch) = (self.metadata(change_id)?, self.branch(change_id)?);
        Ok(ChangeSnapshot {
            tip: branch.tip,
            title: metadata.title.clone(),
            description: metadata.description.clone(),
            archived: metadata.archived,
            permanent: metadata.permanent,
            owners: metadata.owners.clone(),
            parents: metadata.parents()?,
            declared_parents: metadata.declared_parents.clone(),
            review: metadata.review.clone(),
            workspace: branch.workspace()?,
        })
    }

    pub fn merge_base(&self, one: Revision, two: Revision) -> Result<Revision> {
        // TODO(joel): use `merge_base_with_graph`
        Ok(Revision(self.repo.merge_base(one, two)?.detach()))
    }

    pub fn is_predecessor(&self, predecessor: Revision, successor: Revision) -> Result<bool> {
        Ok(self.merge_base(predecessor, successor)? == predecessor)
    }

    /// `ctx.maximal_revisions(revisions)` returns the subset of `revisions` which have no predecessor under `ctx`.
    pub fn maximal_revisions(&self, revisions: &BTreeSet<Revision>) -> Result<BTreeSet<Revision>> {
        let mut candidates = revisions.clone();

        for &candidate in revisions.iter() {
            for &other in candidates.iter() {
                if candidate != other && self.is_predecessor(candidate, other)? {
                    candidates.remove(&candidate);
                    break;
                }
            }
        }

        Ok(candidates)
    }
}

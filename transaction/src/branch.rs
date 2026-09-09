//! A change's branch: the one ref of a change that a workspace can hold.

use std::collections::{BTreeMap, BTreeSet};

use cabaret_types::{ChangeId, ChangeIdRef, ChangedFile, Pathspec, RepoPath, Result, RevisionId, TreeId};
use gix::merge::{
    blob::builtin_driver::text::{Conflict, ConflictStyle, Labels},
    tree::TreatAsUnresolved,
};

use crate::{context::TransactionContext, metadata::Metadata, tree};

/// The revisions a change's diff runs between.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Span {
    /// Empty for a root.
    pub bases: BTreeSet<RevisionId>,
    pub tip: RevisionId,
}

#[derive(Clone, Debug)]
pub struct Branch<'ctx> {
    ctx: &'ctx TransactionContext<'ctx>,
    id: ChangeId,
    /// The revision the branch points at.
    pub tip: RevisionId,
}

impl<'ctx> Branch<'ctx> {
    pub fn new(ctx: &'ctx TransactionContext<'ctx>, id: ChangeId, tip: RevisionId) -> Self { Self { ctx, id, tip } }

    pub fn load(ctx: &'ctx TransactionContext<'ctx>, id: &ChangeIdRef) -> Result<Self> {
        let tip = RevisionId(ctx.repo.find_reference(&id.branch_ref())?.peel_to_commit()?.id);
        Ok(Self::new(ctx, id.to_owned(), tip))
    }

    pub fn ctx(&self) -> &'ctx TransactionContext<'ctx> { self.ctx }

    pub fn id(&self) -> &ChangeIdRef { &self.id }

    /// What the change's diff runs between: the tip, measured against the merge base with each
    /// change it targets (see [`Metadata::parents`]), keeping only the maximal ones. Once the
    /// change is archived after landing, the base and tip recorded then (see
    /// [`Metadata::landed`]): the parent has absorbed the branch, which has nothing of its own
    /// left to show.
    pub fn span(&self, metadata: &Metadata<'_>) -> Result<Span> {
        if let Some(land) = metadata.landed() {
            return Ok(Span { bases: BTreeSet::from([land.base]), tip: land.tip });
        }
        let ctx = self.ctx;
        let mut candidates = BTreeSet::new();
        for parent in &metadata.parents()? {
            candidates.insert(ctx.merge_base(self.tip, ctx.branch(parent)?.tip)?);
        }
        Ok(Span { bases: ctx.maximal_revisions(&candidates)?, tip: self.tip })
    }

    /// The revision the change's diff is computed against: `None` for a root.
    pub fn base(&self, metadata: &Metadata<'_>) -> Result<Option<RevisionId>> {
        self.merged(&self.span(metadata)?.bases)
    }

    /// The revision a reviewer's diff of one file is computed against: the bases merged with
    /// `reviewed`, the tip they last marked the file reviewed at, so only what has changed since
    /// remains to read. The plain base for a file they never marked.
    pub fn review_base(&self, metadata: &Metadata<'_>, reviewed: Option<RevisionId>) -> Result<Option<RevisionId>> {
        let mut revisions = self.span(metadata)?.bases;
        revisions.extend(reviewed);
        self.merged(&revisions)
    }

    /// Several revisions merge into a virtual one, as git's recursive merge does; it lives only
    /// in the object database and is the same commit for the same revisions. `None` for none.
    fn merged(&self, revisions: &BTreeSet<RevisionId>) -> Result<Option<RevisionId>> {
        let revisions = self.ctx.maximal_revisions(revisions)?;
        if revisions.is_empty() {
            return Ok(None);
        }
        let repo = &self.ctx.repo;
        let merged =
            repo.virtual_merge_base(revisions.iter().map(|revision| revision.0), repo.tree_merge_options()?)?;
        Ok(Some(RevisionId(merged.commit_id.detach())))
    }

    /// The file-level changes the change presents over its [`Self::span`], restricted to those
    /// matching `pathspecs` (all when empty).
    pub fn changed_files(&self, metadata: &Metadata<'_>, pathspecs: &[Pathspec]) -> Result<Vec<ChangedFile>> {
        let span = self.span(metadata)?;
        self.changed_files_from(self.merged(&span.bases)?, span.tip, pathspecs)
    }

    /// The file-level changes a reviewer has left to read: each file as the tip differs from the
    /// file's review base (see [`Self::review_base`]), given `review`, the tip they last marked
    /// each file reviewed at. Files are keyed by where they end up.
    pub fn review_files(
        &self,
        metadata: &Metadata<'_>,
        review: &BTreeMap<RepoPath, RevisionId>,
        pathspecs: &[Pathspec],
    ) -> Result<Vec<ChangedFile>> {
        let Span { bases, tip } = self.span(metadata)?;
        // One diff per distinct reviewed tip, `None` covering the files never marked.
        let mut groups: BTreeSet<Option<RevisionId>> = review.values().map(|revision| Some(*revision)).collect();
        groups.insert(None);
        let mut files = Vec::new();
        for reviewed in groups {
            let base = self.merged(&bases.iter().copied().chain(reviewed).collect())?;
            let mut changed = self.changed_files_from(base, tip, pathspecs)?;
            changed.retain(|file| review.get(file.path()).copied() == reviewed);
            files.extend(changed);
        }
        files.sort_by(|a, b| a.path().cmp(b.path()));
        Ok(files)
    }

    fn changed_files_from(
        &self,
        base: Option<RevisionId>,
        tip: RevisionId,
        pathspecs: &[Pathspec],
    ) -> Result<Vec<ChangedFile>> {
        let repo = &self.ctx.repo;
        let base = match base {
            None => None,
            Some(base) => Some(repo.find_commit(base.0)?.tree()?),
        };
        let tip = repo.find_commit(tip.0)?.tree()?;
        tree::changed_files(repo, base.as_ref(), &tip, pathspecs)
    }

    // TODO(joel): for users who are not used to stacking workflows, they may find the rebases encouraged by the change
    // DAG to be somewhat arduous or offputting. To avoid this, it might be good if Cabaret defaulted to a more
    // permissive merge driver. Perhaps we could integrate with mergiraf? They don't have a great interface though.
    // TODO(joel): note that one complication here is that unlike regular git, Cabaret encourages intermediate
    // conflicted states to be committed directly. This means that, to avoid bad conflicts, it needs to be the case that
    // conflicts are resolved in the same way across multiple machines, and thus that we should not allow users to vary
    // or set custom merge drivers.

    /// Merge `other` into this branch as part of `operation`, which names the commit: `None`
    /// when it already contains `other`, else the files left conflicted. A branch with nothing
    /// of its own fast-forwards instead.
    pub fn merge(&mut self, other: &Branch<'ctx>, operation: &str) -> Result<Option<BTreeSet<RepoPath>>> {
        let ctx = self.ctx;
        if ctx.is_predecessor(other.tip, self.tip)? {
            return Ok(None);
        }
        if ctx.is_predecessor(self.tip, other.tip)? {
            self.tip = other.tip;
            return Ok(Some(BTreeSet::new()));
        }

        // Conflict style and labels are forced rather than read from config so the committed
        // conflict text is identical no matter whose clone performs the merge.
        let repo = &ctx.repo;
        let labels =
            Labels { ancestor: Some("base".into()), current: Some(self.id.as_bstr()), other: Some(other.id.as_bstr()) };
        let mut options: gix::merge::plumbing::tree::Options = repo.tree_merge_options()?.into();
        options.blob_merge.text.conflict = Conflict::Keep {
            style: ConflictStyle::ZealousDiff3,
            marker_size: Conflict::DEFAULT_MARKER_SIZE.try_into().expect("the default marker size is non-zero"),
        };
        let mut merge = repo.merge_commits(self.tip, other.tip, labels, options.into())?;
        let tree = TreeId(merge.tree_merge.tree.write()?.detach());
        let conflicts = merge
            .tree_merge
            .conflicts
            .iter()
            .filter(|conflict| conflict.is_unresolved(TreatAsUnresolved::default()))
            .flat_map(|conflict| [&conflict.ours, &conflict.theirs])
            .map(|change| RepoPath::from_bytes(change.location()))
            .collect::<Result<_>>()?;

        let message = format!("{operation}: merge {} into {}", other.id, self.id);
        self.tip = ctx.commit(tree, vec![self.tip, other.tip], message)?;
        Ok(Some(conflicts))
    }
}

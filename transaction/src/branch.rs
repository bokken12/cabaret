//! A change's branch: the one ref of a change that a workspace can hold.

use std::collections::BTreeSet;

use cabaret_types::{ChangeId, ChangeIdRef, ChangedFile, Pathspec, RepoPath, Result, RevisionId, TreeId};
use gix::merge::{
    blob::builtin_driver::text::{Conflict, ConflictStyle, Labels},
    tree::TreatAsUnresolved,
};

use crate::context::TransactionContext;

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

    /// The revisions this branch is measured against: the merge base with each of `parents`, the
    /// changes it targets (see [`Metadata::parents`](crate::metadata::Metadata::parents)),
    /// keeping only the maximal ones. Empty for a root.
    pub fn bases(&self, parents: &BTreeSet<ChangeId>) -> Result<BTreeSet<RevisionId>> {
        let ctx = self.ctx;
        let mut candidates = BTreeSet::new();
        for parent in parents {
            candidates.insert(ctx.merge_base(self.tip, ctx.branch(parent)?.tip)?);
        }
        ctx.maximal_revisions(&candidates)
    }

    /// The revision this branch's diff is computed against: `None` for a root. Multiple bases are
    /// merged into a virtual one, as git's recursive merge does; it lives only in the object
    /// database and is the same commit for the same bases.
    pub fn base(&self, parents: &BTreeSet<ChangeId>) -> Result<Option<RevisionId>> {
        let bases = self.bases(parents)?;
        if bases.is_empty() {
            return Ok(None);
        }
        let repo = &self.ctx.repo;
        let merged = repo.virtual_merge_base(bases.iter().map(|base| base.0), repo.tree_merge_options()?)?;
        Ok(Some(RevisionId(merged.commit_id.detach())))
    }

    /// The file-level changes this branch presents against `parents`, restricted to those
    /// matching `pathspecs` (all when empty).
    pub fn changed_files(&self, parents: &BTreeSet<ChangeId>, pathspecs: &[Pathspec]) -> Result<Vec<ChangedFile>> {
        let repo = &self.ctx.repo;
        let base = match self.base(parents)? {
            None => None,
            Some(base) => Some(repo.find_commit(base.0)?.tree()?),
        };
        let tree = repo.find_commit(self.tip.0)?.tree()?;

        let mut search =
            gix::Pathspec::new(repo, false, pathspecs.iter().map(|spec| spec.0.to_bstring()), false, || {
                Err("attribute pathspecs are not supported".into())
            })?;

        let mut files = repo
            .diff_tree_to_tree(base.as_ref(), Some(&tree), None)?
            .into_iter()
            // rewrite tracking reports moved directories alongside the files within them
            .filter(|change| !change.entry_mode().is_tree())
            .map(ChangedFile::try_from)
            .collect::<Result<Vec<_>>>()?;
        files.retain(|file| file.paths().any(|path| search.is_included(path.as_bstr(), Some(false))));
        Ok(files)
    }

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

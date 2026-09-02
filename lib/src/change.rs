use std::collections::{BTreeMap, BTreeSet};

use gix::{
    bstr::{BString, ByteSlice},
    diff::tree_with_rewrites::Change as TreeChange,
};

use crate::{
    context::TransactionContext,
    error::Result,
    types::{ChangeId, ChangeIdRef, Identity, Pathspec, RepoPath, Revision, RevisionRange},
};

#[derive(Clone, Debug)]
pub struct Change<'ctx> {
    ctx: &'ctx TransactionContext<'ctx>,
    id: ChangeId,
    pub tip: Revision,
    pub title: Option<String>,
    pub description: Option<String>,
    pub archived: bool,
    pub permanent: bool,
    pub owners: BTreeSet<Identity>,
    pub parents: BTreeSet<ChangeId>,
    pub review: BTreeMap<Identity, BTreeMap<RepoPath, RevisionRange>>,
}

impl<'ctx> Change<'ctx> {
    pub fn new(ctx: &'ctx TransactionContext<'ctx>, id: ChangeId, tip: Revision) -> Self {
        Self {
            ctx,
            id,
            tip,
            title: None,
            description: None,
            archived: false,
            permanent: false,
            owners: BTreeSet::new(),
            parents: BTreeSet::new(),
            review: BTreeMap::new(),
        }
    }

    pub fn ctx(&self) -> &TransactionContext<'ctx> { self.ctx }

    pub fn id(&self) -> &ChangeIdRef { &self.id }

    pub fn tip(&self) -> Revision { self.tip }

    pub fn is_descendant(&self, ancestor: &ChangeIdRef) -> Result<bool> {
        if ancestor == self.id.as_ref() {
            return Ok(true);
        }
        self.parents.iter().try_fold(false, |acc, parent| Ok(acc || self.ctx.read(parent)?.is_descendant(ancestor)?))
    }

    pub fn is_ancestor(&self, descendant: &ChangeIdRef) -> Result<bool> {
        Ok(self.ctx.read(descendant)?.is_descendant(&self.id)?)
    }

    // TODO-someday(joel): store computed parents?
    pub fn parents(&self) -> Result<BTreeSet<ChangeId>> {
        if self.archived {
            return Ok(self.parents.clone());
        }

        let mut candidates = BTreeSet::new();
        let mut frontier: Vec<_> = self.parents.iter().cloned().collect();
        loop {
            let Some(candidate_id) = frontier.pop() else { break };
            let candidate = self.ctx.read(&candidate_id)?;

            // skip archived parents and land into their parents
            match candidate.archived {
                false => {
                    candidates.insert(candidate_id);
                }
                true => frontier.extend(candidate.parents.iter().cloned()),
            }
        }
        self.ctx.maximal_changes(&candidates)
    }

    /// No bases ==> change is a root (no parents)
    /// Multiple bases ==> base is the merge of the revisions
    pub fn bases(&self) -> Result<BTreeSet<Revision>> {
        let mut candidates = BTreeSet::new();

        // add merge bases for all parents
        for parent_id in self.parents()? {
            candidates.insert(self.ctx.merge_base(self.tip, self.ctx.read(&parent_id)?.tip)?);
        }

        self.ctx.maximal_revisions(&candidates)
    }
    /// The file-level changes this change presents, restricted to those matching `pathspecs` (all when empty).
    // TODO(joel): multiple bases diff against their merge
    pub fn changed_files(&self, pathspecs: &[Pathspec]) -> Result<Vec<TreeChange>> {
        let repo = &self.ctx.repo;
        let base = match self.bases()?.into_iter().collect::<Vec<Revision>>().as_slice() {
            [] => None,
            [base] => Some(repo.find_commit(base.0)?.tree()?),
            [_, _, ..] => Err(format!("{} has multiple bases, which is not supported yet", self.id))?,
        };
        let tip = repo.find_commit(self.tip.0)?.tree()?;

        let mut search =
            gix::Pathspec::new(repo, false, pathspecs.iter().map(|spec| spec.0.to_bstring()), false, || {
                Err("attribute pathspecs are not supported".into())
            })?;
        let mut included = |location: &BString| search.is_included(location.as_bstr(), Some(false));

        let mut changes = repo.diff_tree_to_tree(base.as_ref(), Some(&tip), None)?;
        changes.retain(|change| match change {
            TreeChange::Addition { location, .. }
            | TreeChange::Deletion { location, .. }
            | TreeChange::Modification { location, .. } => included(location),
            TreeChange::Rewrite { source_location, location, .. } => included(source_location) || included(location),
        });
        Ok(changes)
    }
}

impl<'ctx> TransactionContext<'ctx> {
    pub fn maximal_changes(&'ctx self, changes: &BTreeSet<ChangeId>) -> Result<BTreeSet<ChangeId>> {
        let mut candidates = changes.clone();

        for candidate_id in changes.iter() {
            let candidate = self.read(candidate_id)?;
            for other in candidates.iter() {
                if candidate_id != other && candidate.is_ancestor(other)? {
                    candidates.remove(candidate_id);
                    break;
                }
            }
        }

        Ok(candidates)
    }
}

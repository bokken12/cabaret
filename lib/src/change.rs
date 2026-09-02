use std::collections::{BTreeMap, BTreeSet};

use gix::ObjectId;

use crate::{
    context::TransactionContext,
    error::Result,
    types::{ChangeId, ChangeIdRef, ChangedFile, Identity, Pathspec, RepoPath, Revision, RevisionRange},
};

/// A change's state as of some instant, detached from any transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "napi", napi_derive::napi(object, object_from_js = false))]
pub struct ChangeSnapshot {
    pub tip: Revision,
    pub title: Option<String>,
    pub description: Option<String>,
    pub archived: bool,
    pub permanent: bool,
    pub owners: BTreeSet<Identity>,
    /// What the change targets; see [`Change::parents`].
    pub parents: BTreeSet<ChangeId>,
    /// What its log declares, which is what parent edits act on.
    pub declared_parents: BTreeSet<ChangeId>,
    pub review: BTreeMap<Identity, BTreeMap<RepoPath, RevisionRange>>,
}

#[derive(Clone, Debug)]
pub struct Change<'ctx> {
    ctx: &'ctx TransactionContext<'ctx>,
    id: ChangeId,
    /// The log commit this state was folded from; `None` before the change's first write.
    pub log_commit: Option<ObjectId>,
    pub tip: Revision,
    pub title: Option<String>,
    pub description: Option<String>,
    pub archived: bool,
    pub permanent: bool,
    pub owners: BTreeSet<Identity>,
    pub declared_parents: BTreeSet<ChangeId>,
    pub review: BTreeMap<Identity, BTreeMap<RepoPath, RevisionRange>>,
}

impl<'ctx> Change<'ctx> {
    pub fn new(ctx: &'ctx TransactionContext<'ctx>, id: ChangeId, tip: Revision) -> Self {
        Self {
            ctx,
            id,
            log_commit: None,
            tip,
            title: None,
            description: None,
            archived: false,
            permanent: false,
            owners: BTreeSet::new(),
            declared_parents: BTreeSet::new(),
            review: BTreeMap::new(),
        }
    }

    pub fn ctx(&self) -> &TransactionContext<'ctx> { self.ctx }

    pub fn id(&self) -> &ChangeIdRef { &self.id }

    pub fn tip(&self) -> Revision { self.tip }

    pub fn snapshot(&self) -> Result<ChangeSnapshot> {
        Ok(ChangeSnapshot {
            tip: self.tip,
            title: self.title.clone(),
            description: self.description.clone(),
            archived: self.archived,
            permanent: self.permanent,
            owners: self.owners.clone(),
            parents: self.parents()?,
            declared_parents: self.declared_parents.clone(),
            review: self.review.clone(),
        })
    }

    pub fn is_descendant(&self, ancestor: &ChangeIdRef) -> Result<bool> {
        if ancestor == self.id.as_ref() {
            return Ok(true);
        }
        self.declared_parents
            .iter()
            .try_fold(false, |acc, parent| Ok(acc || self.ctx.read(parent)?.is_descendant(ancestor)?))
    }

    pub fn is_ancestor(&self, descendant: &ChangeIdRef) -> Result<bool> {
        Ok(self.ctx.read(descendant)?.is_descendant(&self.id)?)
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
        loop {
            let Some(candidate_id) = frontier.pop() else { break };
            let candidate = self.ctx.read(&candidate_id)?;

            // skip archived parents and land into their parents
            match candidate.archived {
                false => {
                    candidates.insert(candidate_id);
                }
                true => frontier.extend(candidate.declared_parents.iter().cloned()),
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

    /// The revision this change's diff is computed against: `None` for a root change.
    // TODO(joel): multiple bases diff against their merge
    pub fn base(&self) -> Result<Option<Revision>> {
        match self.bases()?.into_iter().collect::<Vec<Revision>>().as_slice() {
            [] => Ok(None),
            [base] => Ok(Some(*base)),
            [_, _, ..] => Err(format!("{} has multiple bases, which is not supported yet", self.id))?,
        }
    }

    /// The file-level changes this change presents, restricted to those matching `pathspecs` (all when empty).
    pub fn changed_files(&self, pathspecs: &[Pathspec]) -> Result<Vec<ChangedFile>> {
        let repo = &self.ctx.repo;
        let base = match self.base()? {
            None => None,
            Some(base) => Some(repo.find_commit(base.0)?.tree()?),
        };
        let tip = repo.find_commit(self.tip.0)?.tree()?;

        let mut search =
            gix::Pathspec::new(repo, false, pathspecs.iter().map(|spec| spec.0.to_bstring()), false, || {
                Err("attribute pathspecs are not supported".into())
            })?;

        let mut files = repo
            .diff_tree_to_tree(base.as_ref(), Some(&tip), None)?
            .into_iter()
            // rewrite tracking reports moved directories alongside the files within them
            .filter(|change| !change.entry_mode().is_tree())
            .map(ChangedFile::try_from)
            .collect::<Result<Vec<_>>>()?;
        files.retain(|file| file.paths().any(|path| search.is_included(path.as_bstr(), Some(false))));
        Ok(files)
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

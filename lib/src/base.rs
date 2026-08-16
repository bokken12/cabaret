use std::num::NonZeroU8;

use gix::{
    bstr::{BString, ByteSlice},
    merge::blob::builtin_driver::text::{Conflict, Labels},
};

use crate::{
    cabaret::Cabaret,
    error::Result,
    merge::unresolved_paths,
    types::{ChangeId, Revision, TreeId},
};

// TODO(joel): this seems like the wrong representation
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Base {
    /// No parents
    Empty,
    /// Single parent
    Real(Revision),
    /// Multiple parents
    Synthetic { revision: Revision, conflicts: Vec<String> },
}

impl Cabaret {
    /// The base of `change`: the commit its diff is computed against.
    pub fn base(&self, change: &ChangeId) -> Result<Base> {
        let tip = self.tip(change)?;
        let parents = self.change(change)?.parents;
        let mut incorporated = Vec::with_capacity(parents.len());
        for parent in &parents {
            incorporated.push((parent, self.incorporated(change, tip, parent)?));
        }
        let deepest = self.without_dominated(&incorporated)?;
        match deepest.as_slice() {
            [] => Ok(Base::Empty),
            [(_, revision)] => Ok(Base::Real(*revision)),
            _ => self.synthesize(&deepest),
        }
    }

    /// The revision of `parent` that `change`'s tip most recently incorporated.
    fn incorporated(&self, change: &ChangeId, tip: Revision, parent: &ChangeId) -> Result<Revision> {
        let parent_tip = self.tip(parent)?;
        let bases = self.repo.merge_bases_many(tip, &[parent_tip.0])?;
        match bases.as_slice() {
            [] => Err(format!("{change} shares no history with its parent {parent}").into()),
            [base] => Ok(Revision(base.detach())),
            [..] => Err(format!("{change} has an ambiguous base with {parent}; rebase onto it to resolve").into()),
        }
    }

    /// Drop revisions reachable from another: they contribute nothing to a merge of the set.
    /// Parents incorporated at the same revision collapse to one entry.
    fn without_dominated<'a>(
        &self,
        incorporated: &[(&'a ChangeId, Revision)],
    ) -> Result<Vec<(&'a ChangeId, Revision)>> {
        let mut deepest = Vec::new();
        'candidates: for (i, &(parent, revision)) in incorporated.iter().enumerate() {
            for (j, &(_, other)) in incorporated.iter().enumerate() {
                let dominated = if revision == other { j < i } else { j != i && self.is_ancestor(revision, other)? };
                if dominated {
                    continue 'candidates;
                }
            }
            deepest.push((parent, revision));
        }
        Ok(deepest)
    }

    pub fn is_ancestor(&self, ancestor: Revision, descendant: Revision) -> Result<bool> {
        Ok(self.repo.merge_bases_many(ancestor, &[descendant.0])?.iter().any(|base| *base == ancestor.0))
    }

    /// Merge the incorporated revisions pairwise in parent-name order into a synthetic base
    /// commit whose parents are those revisions. The fixed signature and forced merge options
    /// make the commit reproducible: clones agree on the base's identity without exchanging it.
    fn synthesize(&self, incorporated: &[(&ChangeId, Revision)]) -> Result<Base> {
        let (&(first_parent, first), rest) =
            incorporated.split_first().expect("a synthetic base merges at least two revisions");
        let mut merged = first;
        let mut merged_label: BString = first_parent.as_bstr().to_owned();
        let mut tree = TreeId(self.repo.find_commit(merged)?.tree_id()?.detach());
        let mut conflicts: Vec<String> = Vec::new();
        for (index, &(parent, revision)) in rest.iter().enumerate() {
            let labels = Labels {
                ancestor: Some("base".into()),
                current: Some(merged_label.as_bstr()),
                other: Some(parent.as_bstr()),
            };
            let options = self.merge_options(self.marker_size(tree, &conflicts)?)?;
            let mut merge = self.repo.merge_commits(merged, revision, labels, options.into())?;
            tree = TreeId(merge.tree_merge.tree.write()?.detach());
            conflicts.extend(unresolved_paths(&merge.tree_merge));
            merged_label.extend_from_slice(b"+");
            merged_label.extend_from_slice(parent.as_bstr());
            if index + 1 < rest.len() {
                merged = self.synthetic_commit(tree, vec![merged, revision])?;
            }
        }
        conflicts.sort();
        conflicts.dedup();
        let revisions = incorporated.iter().map(|&(_, revision)| revision).collect();
        Ok(Base::Synthetic { revision: self.synthetic_commit(tree, revisions)?, conflicts })
    }

    /// Markers must outsize any markers already committed at the conflicted paths, or nested
    /// conflicts would be ambiguous.
    fn marker_size(&self, tree: TreeId, conflicts: &[String]) -> Result<NonZeroU8> {
        let mut size = usize::from(Conflict::DEFAULT_MARKER_SIZE);
        let tree = self.repo.find_tree(tree)?;
        for path in conflicts {
            let Some(entry) = tree.lookup_entry_by_path(path)? else { continue };
            let Ok(blob) = entry.object()?.try_into_blob() else { continue };
            for line in blob.data.lines() {
                size = size.max(leading_marker_run(line) + 4);
            }
        }
        let size = u8::try_from(size).map_err(|_| "conflict markers nested too deep to disambiguate")?;
        Ok(size.try_into().expect("marker size is at least the non-zero default"))
    }

    /// A commit derived only from its content — fixed signature, epoch timestamp.
    fn synthetic_commit(&self, tree: TreeId, parents: Vec<Revision>) -> Result<Revision> {
        let signature =
            gix::actor::Signature { name: "cabaret".into(), email: "".into(), time: gix::date::Time::new(0, 0) };
        let commit = gix::objs::Commit {
            tree: tree.into(),
            parents: parents.into_iter().map(Into::into).collect(),
            author: signature.clone(),
            committer: signature,
            encoding: None,
            message: "synthetic base\n".into(),
            extra_headers: Vec::new(),
        };
        Ok(Revision(self.repo.write_object(&commit)?.detach()))
    }
}

fn leading_marker_run(line: &[u8]) -> usize {
    match line.first() {
        Some(&marker @ (b'<' | b'|' | b'=' | b'>')) => line.iter().take_while(|&&byte| byte == marker).count(),
        _ => 0,
    }
}

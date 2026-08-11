use std::{collections::BTreeSet, fs, path::Path};

use gix::{
    ObjectId,
    bstr::{BString, ByteSlice},
    merge::blob::builtin_driver::text::{Conflict, ConflictStyle, Labels},
};

use crate::{cabaret::Cabaret, error::Result, types::ChangeId};

#[derive(Debug, PartialEq, Eq)]
pub enum Rebase {
    UpToDate,
    Merged { conflicts: Vec<String> },
}

fn branch_ref(change: &ChangeId) -> String { format!("refs/heads/{change}") }

impl Cabaret {
    /// Merge `onto`'s tip into `change`. Conflicts are committed immediately with
    /// conflict markers in the affected files, never left as an in-progress merge.
    pub fn rebase(&self, change: &ChangeId, onto: &ChangeId) -> Result<Rebase> {
        let change_tip = self.tip(change)?;
        let parent_tip = self.tip(onto)?;
        if self.repo.merge_base(change_tip, parent_tip)? == parent_tip {
            return Ok(Rebase::UpToDate);
        }

        let checked_out =
            self.repo.head_name()?.is_some_and(|head| head.as_bstr() == branch_ref(change).as_bytes().as_bstr());
        let worktree = if checked_out { self.repo.workdir().map(Path::to_owned) } else { None };
        if worktree.is_some() && self.repo.is_dirty()? {
            return Err("working tree has uncommitted changes".into());
        }

        // Conflict style and labels are forced rather than read from config so the committed
        // conflict text is identical no matter whose clone performs the rebase.
        let labels = Labels {
            ancestor: Some("base".into()),
            current: Some(change.0.as_str().into()),
            other: Some(onto.0.as_str().into()),
        };
        let mut options: gix::merge::plumbing::tree::Options = self.repo.tree_merge_options()?.into();
        options.blob_merge.text.conflict = Conflict::Keep {
            style: ConflictStyle::ZealousDiff3,
            marker_size: Conflict::DEFAULT_MARKER_SIZE.try_into().expect("marker size is non-zero"),
        };
        let options = gix::merge::tree::Options::from(options);
        let mut merge = self.repo.merge_commits(change_tip, parent_tip, labels, options.into())?;
        let merged_tree = merge.tree_merge.tree.write()?.detach();
        let unresolved = gix::merge::tree::TreatAsUnresolved::default();
        let mut conflicts: Vec<String> = merge
            .tree_merge
            .conflicts
            .iter()
            .filter(|conflict| conflict.is_unresolved(unresolved))
            .map(|conflict| conflict.changes_in_resolution().0.location().to_string())
            .collect();
        conflicts.sort();
        conflicts.dedup();

        self.repo.commit(
            branch_ref(change).as_str(),
            format!("rebase onto {onto}"),
            merged_tree,
            [change_tip, parent_tip],
        )?;

        if let Some(workdir) = worktree {
            self.checkout(&workdir, merged_tree)?;
        }
        Ok(Rebase::Merged { conflicts })
    }

    fn tip(&self, change: &ChangeId) -> Result<ObjectId> {
        Ok(self.repo.find_reference(&branch_ref(change))?.peel_to_commit()?.id)
    }

    /// Make the (clean) worktree and index match `tree`.
    // TODO-someday(jm): apply only the delta between the old and new trees; rewriting every
    // file on each rebase won't fly in a large repository.
    fn checkout(&self, workdir: &Path, tree: ObjectId) -> Result<()> {
        let mut index = self.repo.index_from_tree(&tree)?;

        let old = self.repo.open_index()?;
        let keep: BTreeSet<BString> = index.entries().iter().map(|entry| entry.path(&index).to_owned()).collect();
        for entry in old.entries() {
            let path = entry.path(&old);
            if !keep.contains(path.as_bstr()) {
                let path = workdir.join(gix::path::from_bstr(path));
                fs::remove_file(&path)?;
                prune_empty_dirs(workdir, path.parent().expect("worktree files have a parent"));
            }
        }

        let mut options = self.repo.checkout_options(gix::worktree::stack::state::attributes::Source::IdMapping)?;
        options.overwrite_existing = true;
        gix::worktree::state::checkout(
            &mut index,
            workdir,
            self.repo.objects.clone().into_arc()?,
            &gix::progress::Discard,
            &gix::progress::Discard,
            &gix::interrupt::IS_INTERRUPTED,
            options,
        )?;
        index.write(gix::index::write::Options::default())?;
        Ok(())
    }
}

fn prune_empty_dirs(workdir: &Path, mut dir: &Path) {
    while dir != workdir && fs::remove_dir(dir).is_ok() {
        dir = dir.parent().expect("pruning stops at the worktree root");
    }
}

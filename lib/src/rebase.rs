use std::{collections::BTreeSet, fs, path::Path};

use gix::{
    ObjectId,
    bstr::{BString, ByteSlice},
    merge::blob::builtin_driver::text::{Conflict, ConflictStyle, Labels},
    refs::FullName,
};

use crate::{cabaret::Cabaret, error::Result, types::ChangeId};

#[derive(Debug, PartialEq, Eq)]
pub enum Rebase {
    UpToDate,
    Merged { conflicts: Vec<String> },
}

impl Cabaret {
    /// Merge `onto`'s tip into `change`. Conflicts are committed immediately with
    /// conflict markers in the affected files, never left as an in-progress merge.
    pub fn rebase(&self, change: &ChangeId, onto: &ChangeId) -> Result<Rebase> {
        let change_tip = self.tip(change)?;
        let parent_tip = self.tip(onto)?;
        if self.repo.merge_base(change_tip, parent_tip)? == parent_tip {
            return Ok(Rebase::UpToDate);
        }

        let branch = change.branch_ref();
        let checked_out = self.repo.head_name()?.is_some_and(|head| head == branch);
        let worktree = if checked_out {
            self.repo.workdir().map(Path::to_owned)
        } else {
            // Never move the branch under another workspace: its index and files would be left
            // describing the old tip, and this rebase cannot see whether it is even clean.
            if let Some(workspace) = self.workspace_holding(&branch)? {
                return Err(
                    format!("{change} is checked out in workspace {}; rebase there", workspace.display()).into()
                );
            }
            None
        };
        if worktree.is_some() && self.repo.is_dirty()? {
            return Err("working tree has uncommitted changes".into());
        }

        // Conflict style and labels are forced rather than read from config so the committed
        // conflict text is identical no matter whose clone performs the rebase.
        let labels = Labels {
            ancestor: Some("base".into()),
            current: Some(change.as_bstr()),
            other: Some(onto.as_bstr()),
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
            branch,
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
        Ok(self.repo.find_reference(&change.branch_ref())?.peel_to_commit()?.id)
    }

    /// The workdir of the workspace that has `branch` checked out, if any.
    fn workspace_holding(&self, branch: &FullName) -> Result<Option<std::path::PathBuf>> {
        let mut repos = vec![self.repo.main_repo()?];
        for proxy in self.repo.worktrees()? {
            repos.push(proxy.into_repo_with_possibly_inaccessible_worktree()?);
        }
        for repo in repos {
            if repo.workdir().is_some() && repo.head_name()?.is_some_and(|head| head == *branch) {
                return Ok(repo.workdir().map(Path::to_owned));
            }
        }
        Ok(None)
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

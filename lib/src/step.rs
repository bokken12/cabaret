use std::fmt;

use gix::{ObjectId, bstr::ByteSlice, object::tree::diff::ChangeDetached};

use crate::{base::Base, cabaret::Cabaret, error::Result, types::ChangeId};

/// What must happen next to move a change toward landing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NextStep {
    FixConflicts,
    FixConflictsInParent,
    Rebase,
    AddCode,
    LandParents,
    Land,
}

impl fmt::Display for NextStep {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.pad(match self {
            Self::FixConflicts => "fix conflicts",
            Self::FixConflictsInParent => "fix conflicts in parent",
            Self::Rebase => "rebase",
            Self::AddCode => "add code",
            Self::LandParents => "land parents",
            Self::Land => "land",
        })
    }
}

impl Cabaret {
    /// The next action that moves `change` toward landing. The change's own conflicts come
    /// first: markers are not code worth building on. A conflicted parent comes next —
    /// rebasing onto its markers would only spread them, so the parent's fix is what this
    /// change waits for. Then a stale parent — its tip not an ancestor of the change's —
    /// since every reading below compares against a base the rebase would move. An empty
    /// change has nothing to land, and a multi-parent change cannot land until its parents
    /// land and it collapses onto one.
    pub fn next_step(&self, change: &ChangeId) -> Result<NextStep> {
        let tip = self.tip(change)?;
        let parents = self.parents(change)?;
        let (tip_tree, base_tree) = self.endpoint_trees(change)?;
        if self.markers_between(base_tree, tip_tree)? {
            return Ok(NextStep::FixConflicts);
        }
        for parent in &parents {
            // Trunk parents have no log to read a base from; they are trusted marker-free.
            if self.repo.try_find_reference(&parent.log_ref())?.is_some() && self.conflicted(parent)? {
                return Ok(NextStep::FixConflictsInParent);
            }
        }
        for parent in &parents {
            if !self.is_predecessor(self.tip(parent)?, tip)? {
                return Ok(NextStep::Rebase);
            }
        }
        if tip_tree == base_tree {
            return Ok(NextStep::AddCode);
        }
        Ok(if parents.len() > 1 { NextStep::LandParents } else { NextStep::Land })
    }

    /// Whether a file `change` touched since its base carries conflict markers at its tip.
    fn conflicted(&self, change: &ChangeId) -> Result<bool> {
        let (tip_tree, base_tree) = self.endpoint_trees(change)?;
        self.markers_between(base_tree, tip_tree)
    }

    /// Whether a blob changed between the trees carries conflict markers on the tip side.
    /// Only this diff is scanned: everything below the base is assumed marker-free, each
    /// change reporting its own conflicts.
    fn markers_between(&self, base_tree: ObjectId, tip_tree: ObjectId) -> Result<bool> {
        let base = self.repo.find_tree(base_tree)?;
        let tip = self.repo.find_tree(tip_tree)?;
        for diff in self.repo.diff_tree_to_tree(Some(&base), Some(&tip), None)? {
            let (mode, id) = diff.entry_mode_and_id();
            if matches!(diff, ChangeDetached::Deletion { .. }) || !mode.is_blob() {
                continue;
            }
            let blob = self.repo.find_object(id.to_owned())?.try_into_blob()?;
            if blob.data.lines().any(|line| line.starts_with(b"<<<<<<<")) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// The trees of `change`'s tip and base: the endpoints of its diff.
    fn endpoint_trees(&self, change: &ChangeId) -> Result<(ObjectId, ObjectId)> {
        let tip_tree = self.repo.find_commit(self.tip(change)?)?.tree_id()?.detach();
        let base_tree = match self.base(change)? {
            Base::Empty => self.repo.empty_tree().id,
            Base::Real(revision) | Base::Synthetic { revision, .. } => {
                self.repo.find_commit(revision)?.tree_id()?.detach()
            }
        };
        Ok((tip_tree, base_tree))
    }
}

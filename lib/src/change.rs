use std::collections::BTreeSet;

use nonempty_collections::NEVec;

use crate::{
    cabaret::Cabaret,
    error::Result,
    revision::Revision,
    types::{ChangeId, Liveness},
};

pub enum Base {
    Root,
    Merge(NEVec<Revision>),
}

impl Cabaret {
    pub fn base(&self, change: &ChangeId) -> Result<Base> {
        let tip = self.tip(change)?;
        let mut bases = self
            .parents(change)?
            .iter()
            .map(|parent| Ok(self.merge_base(tip, self.tip(parent)?)?))
            .collect::<Result<Vec<Revision>>>()?;
        bases.sort_unstable();
        bases.dedup();

        match NEVec::try_from_vec(bases) {
            None => Ok(Base::Root),
            Some(bases) => Ok(Base::Merge(bases)),
        }
    }

    // TODO(jm): decide on if this should be reflexive
    pub fn is_ancestor(&self, ancestor: &ChangeId, descendant: &ChangeId) -> bool {
        ancestor == descendant
            || match self.log(descendant) {
                Err(_) => false,
                Ok(log) => log.parents.iter().any(|parent| self.is_ancestor(ancestor, parent)),
            }
    }

    pub fn is_archived(&self, change: &ChangeId) -> Result<bool> {
        match self.log(change)?.liveness {
            Liveness::Archived => Ok(true),
            Liveness::Live | Liveness::Permanent => Ok(false),
        }
    }

    pub fn is_permanent(&self, change: &ChangeId) -> Result<bool> {
        match self.log(change)?.liveness {
            Liveness::Permanent => Ok(true),
            Liveness::Live | Liveness::Archived => Ok(false),
        }
    }

    pub fn parents(&self, change: &ChangeId) -> Result<BTreeSet<ChangeId>> {
        let mut frontier: Vec<_> = self.log(change)?.parents.into_iter().collect();
        let mut parents = BTreeSet::new();

        // Skip archived changes and target their parents directly.
        loop {
            let Some(candidate) = frontier.pop() else { break };
            match self.is_archived(&candidate)? {
                false => {
                    parents.insert(candidate);
                }
                true => {
                    frontier.extend(self.log(&candidate)?.parents);
                }
            }
        }

        // Skip dominators since their children will release into them.
        Ok(parents
            .iter()
            .filter(|candidate| parents.iter().all(|other| *candidate == other || !self.is_ancestor(candidate, other)))
            .cloned()
            .collect())
    }

    pub fn tip(&self, change: &ChangeId) -> Result<Revision> {
        Ok(Revision(self.repo.find_reference(&change.branch_ref())?.peel_to_commit()?.id))
    }

    /// `title(change)` is `change`'s title if set, otherwise its ID.
    pub fn title(&self, change: &ChangeId) -> Result<String> {
        Ok(self.log(change)?.title.unwrap_or_else(|| change.to_string()))
    }
}

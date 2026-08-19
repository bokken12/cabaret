use std::collections::BTreeSet;

use nonempty_collections::NEVec;

use crate::{
    cabaret::Cabaret,
    error::Result,
    revision::Revision,
    types::{ChangeId, ChangeIdRef, Liveness},
};

pub enum Base {
    Root,
    Merge(NEVec<Revision>),
}

impl Cabaret {
    /// `base(change)` gives the base that `change`'s tip should be diffed against, using`change` and its parents.
    pub fn base(&self, change: &ChangeIdRef) -> Result<Base> {
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

    // TODO(joel): decide on if this should be reflexive
    /// `is_ancestor(a, b)` IFF `a` is a parent of `b` (transitive + reflexive).
    pub fn is_ancestor(&self, ancestor: &ChangeIdRef, descendant: &ChangeIdRef) -> bool {
        ancestor == descendant
            || match self.log(descendant) {
                Err(_) => false,
                Ok(log) => log.parents.iter().any(|parent| self.is_ancestor(ancestor, parent)),
            }
    }

    pub fn is_archived(&self, change: &ChangeIdRef) -> Result<bool> {
        match self.log(change)?.liveness {
            Liveness::Archived => Ok(true),
            Liveness::Live | Liveness::Permanent => Ok(false),
        }
    }

    pub fn land_into(&self, change: &ChangeIdRef) -> Result<Option<ChangeId>> {
        // TODO(joel): check for conflicts
        let mut parents = self.parents(change)?;
        if parents.len() == 1 { Ok(Some(parents.pop_first().unwrap())) } else { Ok(None) }
    }

    pub fn is_landable(&self, change: &ChangeIdRef) -> Result<bool> { Ok(self.land_into(change)?.is_some()) }

    pub fn is_permanent(&self, change: &ChangeIdRef) -> Result<bool> {
        match self.log(change)?.liveness {
            Liveness::Permanent => Ok(true),
            Liveness::Live | Liveness::Archived => Ok(false),
        }
    }

    /// `parents(change)` is the minimal set of unarchived parents for `change`.
    pub fn parents(&self, change: &ChangeIdRef) -> Result<BTreeSet<ChangeId>> {
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

    pub fn set_archived(&self, change: &ChangeIdRef, archived: bool) -> Result<()> {
        // TODO(joel): warn/error if there are children
        if self.is_permanent(change)? {
            return Err(format!("{change} is permanent").into());
        }

        self.set_liveness(change, if archived { Liveness::Archived } else { Liveness::Live })
    }

    pub fn set_permanent(&self, change: &ChangeIdRef, permanent: bool) -> Result<()> {
        if self.is_archived(change)? {
            return Err(format!("{change} is archived").into());
        }

        self.set_liveness(change, if permanent { Liveness::Permanent } else { Liveness::Live })
    }

    pub fn tip(&self, change: &ChangeIdRef) -> Result<Revision> {
        Ok(Revision(self.repo.find_reference(&change.branch_ref())?.peel_to_commit()?.id))
    }

    /// `title(change)` is `change`'s title if set, otherwise its ID.
    pub fn title(&self, change: &ChangeIdRef) -> Result<String> {
        Ok(self.log(change)?.title.unwrap_or_else(|| change.to_string()))
    }
}

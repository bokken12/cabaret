use std::collections::BTreeSet;

use nonempty_collections::NEVec;

use crate::{
    cabaret::Cabaret,
    error::Result,
    types::{ChangeId, Liveness, Revision},
};

pub enum Base {
    Root,
    Single(Revision),
    // TODO-someday(joel): NSVec
    Merge(NEVec<Revision>),
}

impl Cabaret {
    // pub fn base(&self, change: &ChangeId) -> Base {
    //     let parents: Vec<_> = self.parents(change)?.into_iter().collect();

    //     match parents.as_slice() {
    //         [] => Base::Root,
    //         [parent] => todo!(),
    //         _ => todo!(),
    //     }
    // }

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

    /// `title(change)` is `change`'s title if set, otherwise its ID.
    pub fn title(&self, change: &ChangeId) -> Result<String> {
        Ok(self.log(change)?.title.unwrap_or_else(|| change.to_string()))
    }
}

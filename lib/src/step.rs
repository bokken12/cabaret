use std::fmt;

use crate::{cabaret::Cabaret, change::ChangeId, error::Result};

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
    // TODO(joel): expand steps
    pub fn next_step(&self, change: &ChangeId) -> Result<NextStep> {
        let tip = self.tip(change)?;
        let parents = self.parents(change)?;
        for parent in &parents {
            if !self.rev_is_ancestor(self.tip(parent)?, tip)? {
                return Ok(NextStep::Rebase);
            }
        }
        Ok(if parents.len() > 1 { NextStep::LandParents } else { NextStep::Land })
    }
}

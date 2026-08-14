use crate::{
    cabaret::Cabaret,
    types::{Path, RevisionRange},
};

// TODO(joel): rename
pub enum DiffUnit {
    Modify { path: Path },
    Move { from: Path, into: Path },
    Copy { from: Path, into: Path },
}

// TODO(joel): determine representation
// Contains hunks?
// Contains per-line but also within-line diff info?
pub struct Diff {}

impl Cabaret {
    pub fn diff(unit: DiffUnit, range: &RevisionRange, relative_to: &Option<RevisionRange>) -> Diff { todo!() }

    // TODO(joel): better signature? include move/copy?
    pub fn diffs(range: &RevisionRange, relative_to: &Option<RevisionRange>) -> Vec<DiffUnit> { todo!() }
}

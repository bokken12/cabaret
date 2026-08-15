use crate::{
    cabaret::Cabaret,
    types::{RepoPath, RevisionRange},
};

// TODO(joel): rename
pub enum DiffUnit {
    Modify { path: RepoPath },
    Move { from: RepoPath, into: RepoPath },
    Copy { from: RepoPath, into: RepoPath },
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

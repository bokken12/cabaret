use crate::{cabaret::CabaretOld, revision::RevisionRange, types::RepoPath};

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

impl CabaretOld {
    pub fn diff(_unit: DiffUnit, _range: &RevisionRange, _relative_to: &Option<RevisionRange>) -> Diff { todo!() }

    // TODO(joel): better signature? include move/copy?
    pub fn diffs(_range: &RevisionRange, _relative_to: &Option<RevisionRange>) -> Vec<DiffUnit> { todo!() }
}

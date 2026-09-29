use gix::bstr::BString;

use crate::repo_path::RepoPath;

/// A line a change's diff adds, as it stands at the tip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddedLine {
    pub path: RepoPath,
    /// Counted from 1, as editors and `git grep -n` do.
    pub number: usize,
    /// Without its line terminator.
    pub text: BString,
}

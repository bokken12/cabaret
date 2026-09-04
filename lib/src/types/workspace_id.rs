use std::fmt;

use gix::bstr::BString;

// TODO-someday(joel): add a WorkspaceIdRef

/// A working directory of the repository. Git names linked worktrees by their admin directory
/// under `.git/worktrees/` and leaves the main one nameless, so it gets its own case.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum WorkspaceId {
    Main,
    Linked(BString),
}

impl fmt::Display for WorkspaceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Main => f.write_str("main"),
            Self::Linked(id) => fmt::Display::fmt(id, f),
        }
    }
}

impl fmt::Debug for WorkspaceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { fmt::Debug::fmt(&self.to_string(), f) }
}

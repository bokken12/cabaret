use std::str::FromStr;

use gix::pathspec::{self, MagicSignature, Pattern};

use crate::repo_path::RepoPath;

// TODO(joel): rename to be less ambiguous?
#[derive(Debug, Clone)]
pub struct Pathspec(pub Pattern);

impl Pathspec {
    /// Matches `path` and nothing else, however glob-like its name.
    pub fn literal(path: &RepoPath) -> Self { Self(Pattern::from_literal(path.as_bstr(), MagicSignature::empty())) }
}

impl FromStr for Pathspec {
    type Err = pathspec::parse::Error;

    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        pathspec::parse(s.as_bytes(), pathspec::Defaults::default()).map(Self)
    }
}

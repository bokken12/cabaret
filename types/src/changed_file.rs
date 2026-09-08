use gix::diff::tree_with_rewrites::Change as TreeChange;

use crate::{error::Error, repo_path::RepoPath};

/// One file-level difference a change presents.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "napi", napi_derive::napi(discriminant = "kind"))]
pub enum ChangedFile {
    Added { path: RepoPath },
    Deleted { path: RepoPath },
    Modified { path: RepoPath },
    Renamed { from: RepoPath, path: RepoPath },
    Copied { from: RepoPath, path: RepoPath },
}

impl ChangedFile {
    /// Where this leaves the file.
    pub fn path(&self) -> &RepoPath {
        match self {
            Self::Added { path }
            | Self::Deleted { path }
            | Self::Modified { path }
            | Self::Renamed { path, .. }
            | Self::Copied { path, .. } => path,
        }
    }

    /// The paths this touches: the file's, preceded by its source for a rename or copy.
    pub fn paths(&self) -> impl Iterator<Item = &RepoPath> {
        let from = match self {
            Self::Renamed { from, .. } | Self::Copied { from, .. } => Some(from),
            Self::Added { .. } | Self::Deleted { .. } | Self::Modified { .. } => None,
        };
        from.into_iter().chain(std::iter::once(self.path()))
    }
}

impl TryFrom<TreeChange> for ChangedFile {
    type Error = Error;

    fn try_from(change: TreeChange) -> Result<Self, Error> {
        Ok(match change {
            TreeChange::Addition { location, .. } => Self::Added { path: RepoPath::from_bytes(location.as_ref())? },
            TreeChange::Deletion { location, .. } => Self::Deleted { path: RepoPath::from_bytes(location.as_ref())? },
            TreeChange::Modification { location, .. } => {
                Self::Modified { path: RepoPath::from_bytes(location.as_ref())? }
            }
            TreeChange::Rewrite { source_location, location, copy, .. } => {
                let from = RepoPath::from_bytes(source_location.as_ref())?;
                let path = RepoPath::from_bytes(location.as_ref())?;
                match copy {
                    false => Self::Renamed { from, path },
                    true => Self::Copied { from, path },
                }
            }
        })
    }
}

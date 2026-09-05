use std::{fmt, path::Path};

use gix::bstr::{BStr, BString};

use crate::error::Result;

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum WorkspaceId {
    Main,
    Linked(BString),
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum WorkspaceIdRef<'a> {
    Main,
    Linked(&'a BStr),
}

impl WorkspaceId {
    /// The id git gives a linked worktree at `path`: its directory name.
    pub fn linked_at(path: &Path) -> Result<Self> {
        let name = path.file_name().ok_or_else(|| format!("{} does not name a directory", path.display()))?;
        Ok(Self::Linked(gix::path::os_str_into_bstr(name)?.to_owned()))
    }

    pub fn to_ref(&self) -> WorkspaceIdRef<'_> {
        match self {
            Self::Main => WorkspaceIdRef::Main,
            Self::Linked(id) => WorkspaceIdRef::Linked(id.as_ref()),
        }
    }
}

impl WorkspaceIdRef<'_> {
    pub fn into_owned(self) -> WorkspaceId {
        match self {
            Self::Main => WorkspaceId::Main,
            Self::Linked(id) => WorkspaceId::Linked(id.to_owned()),
        }
    }
}

impl<'a> From<&'a WorkspaceId> for WorkspaceIdRef<'a> {
    fn from(id: &'a WorkspaceId) -> Self { id.to_ref() }
}

impl PartialEq<WorkspaceIdRef<'_>> for WorkspaceId {
    fn eq(&self, other: &WorkspaceIdRef<'_>) -> bool { self.to_ref() == *other }
}

impl PartialEq<WorkspaceId> for WorkspaceIdRef<'_> {
    fn eq(&self, other: &WorkspaceId) -> bool { *self == other.to_ref() }
}

impl fmt::Display for WorkspaceIdRef<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Main => f.write_str("main"),
            Self::Linked(id) => fmt::Display::fmt(id, f),
        }
    }
}

impl fmt::Display for WorkspaceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { fmt::Display::fmt(&self.to_ref(), f) }
}

impl fmt::Debug for WorkspaceIdRef<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { fmt::Debug::fmt(&self.to_string(), f) }
}

impl fmt::Debug for WorkspaceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { fmt::Debug::fmt(&self.to_ref(), f) }
}

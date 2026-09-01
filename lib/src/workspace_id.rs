use std::{
    borrow::Borrow,
    collections::BTreeSet,
    fmt, fs,
    ops::Deref,
    path::{Path, PathBuf},
};

use gix::{
    Repository,
    bstr::{BStr, BString, ByteSlice},
    refs::{FullName, TargetRef},
};
use ref_cast::RefCast;

use crate::{
    cabaret::Cabaret,
    error::Result,
    types::{ChangeId, ChangeIdRef, Revision, TreeId},
};

// TODO(joel): extract to util crate
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct WorkspaceId(BString);

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord, RefCast)]
#[repr(transparent)]
pub struct WorkspaceIdRef(BStr);

impl Borrow<WorkspaceIdRef> for WorkspaceId {
    fn borrow(&self) -> &WorkspaceIdRef { WorkspaceIdRef::ref_cast(self.0.as_ref()) }
}

impl AsRef<WorkspaceIdRef> for WorkspaceId {
    fn as_ref(&self) -> &WorkspaceIdRef { self.borrow() }
}

impl Deref for WorkspaceId {
    type Target = WorkspaceIdRef;

    fn deref(&self) -> &Self::Target { self.borrow() }
}

impl ToOwned for WorkspaceIdRef {
    type Owned = WorkspaceId;

    fn to_owned(&self) -> Self::Owned { WorkspaceId(self.0.to_owned()) }
}

impl fmt::Display for WorkspaceIdRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { self.0.fmt(f) }
}

impl fmt::Display for WorkspaceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { self.as_ref().fmt(f) }
}

impl WorkspaceIdRef {
    fn head_ref(&self) -> FullName {
        FullName::try_from(format!("worktrees/{self}/HEAD")).expect("worktree produces valid ref")
    }
}

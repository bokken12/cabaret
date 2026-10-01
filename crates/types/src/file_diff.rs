use crate::{changed_file::ChangedFile, revision::RevisionId};

/// A file with the revisions holding each side of its diff, the before side at the path it
/// comes from: `before` is `None` just when it is added, and `after` just when it is deleted.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "napi", napi_derive::napi(object, object_from_js = false))]
pub struct FileDiff {
    pub file: ChangedFile,
    pub before: Option<RevisionId>,
    pub after: Option<RevisionId>,
}

impl FileDiff {
    /// `file` as it differs from `before` to `after`, keeping only the sides it is on.
    pub fn new(file: ChangedFile, before: RevisionId, after: RevisionId) -> Self {
        let before = match file {
            ChangedFile::Added { .. } => None,
            _ => Some(before),
        };
        let after = match file {
            ChangedFile::Deleted { .. } => None,
            _ => Some(after),
        };
        Self { file, before, after }
    }
}

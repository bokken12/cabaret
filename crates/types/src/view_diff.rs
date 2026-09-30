use crate::{file_diff::FileDiff, revision::RevisionId};

/// The files a view of a change diffs, as of the change's `tip`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "napi", napi_derive::napi(object, object_from_js = false))]
pub struct ViewDiff {
    pub tip: RevisionId,
    pub files: Vec<FileDiff>,
}

use serde::{Deserialize, Serialize};

use crate::{change_id::ChangeId, revision::RevisionId};

/// One landing of a change, as its log records it: what was merged into `parent`, as the diff
/// from `base` to `tip` at the time, kept so the landed version can be shown after the branch
/// has nothing left to measure against.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi_derive::napi(object, object_from_js = false))]
pub struct Land {
    pub parent: ChangeId,
    pub base: RevisionId,
    pub tip: RevisionId,
}

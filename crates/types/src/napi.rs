//! How the value types cross into JS: each as its string form.

use napi::{
    bindgen_prelude::{FromNapiValue, ToNapiValue},
    sys,
};

use crate::{change_id::ChangeId, error::Error, repo_path::RepoPath, revision::RevisionId, workspace_id::WorkspaceId};

// SAFETY (both macros): `env` and `val` are forwarded unchanged to `String`'s impls, inheriting their contract.
macro_rules! to_js_as_string {
    ($($t:ty),*) => {$(
        impl ToNapiValue for $t {
            unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
                unsafe { String::to_napi_value(env, val.to_string()) }
            }
        }
    )*};
}

macro_rules! from_js_as_string {
    ($($t:ty),*) => {$(
        impl FromNapiValue for $t {
            unsafe fn from_napi_value(env: sys::napi_env, val: sys::napi_value) -> napi::Result<Self> {
                Ok(unsafe { String::from_napi_value(env, val)? }.parse().map_err(Error::from)?)
            }
        }
    )*};
}

// TODO-someday(joel): property-test that types in both lists round-trip through their string form.
to_js_as_string!(RepoPath, ChangeId, RevisionId, WorkspaceId);
from_js_as_string!(RepoPath, ChangeId, RevisionId);

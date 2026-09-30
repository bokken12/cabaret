//! How the value types cross into JS: each as its string form.

// The napi boundary requires owned values for JS primitives.
#![allow(clippy::needless_pass_by_value)]

use napi::{
    bindgen_prelude::{FromNapiValue, ToNapiValue},
    sys,
};

use crate::{
    change_id::ChangeId, error::Error, identity::Identity, repo_path::RepoPath, revision::RevisionId,
    workspace_id::WorkspaceId,
};

// TODO(joel): rid myself of unsafe
impl ToNapiValue for RepoPath {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        unsafe { String::to_napi_value(env, val.to_string()) }
    }
}

impl FromNapiValue for RepoPath {
    unsafe fn from_napi_value(env: sys::napi_env, val: sys::napi_value) -> napi::Result<Self> {
        Ok(unsafe { String::from_napi_value(env, val)? }.parse().map_err(Error::from)?)
    }
}

impl ToNapiValue for Identity {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        unsafe { String::to_napi_value(env, val.0) }
    }
}

impl FromNapiValue for Identity {
    unsafe fn from_napi_value(env: sys::napi_env, val: sys::napi_value) -> napi::Result<Self> {
        Ok(Self(unsafe { String::from_napi_value(env, val)? }))
    }
}

impl ToNapiValue for ChangeId {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        unsafe { String::to_napi_value(env, val.to_string()) }
    }
}

impl FromNapiValue for ChangeId {
    unsafe fn from_napi_value(env: sys::napi_env, val: sys::napi_value) -> napi::Result<Self> {
        Ok(unsafe { String::from_napi_value(env, val)? }.parse().map_err(Error::from)?)
    }
}

impl ToNapiValue for RevisionId {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        unsafe { String::to_napi_value(env, val.to_string()) }
    }
}

impl FromNapiValue for RevisionId {
    unsafe fn from_napi_value(env: sys::napi_env, val: sys::napi_value) -> napi::Result<Self> {
        Ok(Self(unsafe { String::from_napi_value(env, val)? }.parse().map_err(Error::from)?))
    }
}

impl ToNapiValue for WorkspaceId {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        unsafe { String::to_napi_value(env, val.to_string()) }
    }
}

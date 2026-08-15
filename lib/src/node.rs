// The napi boundary requires owned values for JS primitives.
#![allow(clippy::needless_pass_by_value)]

use napi::{
    bindgen_prelude::{FromNapiValue, ToNapiValue},
    sys,
};
use napi_derive::napi;

use crate::{
    cabaret::Cabaret,
    error::Error,
    types::{Change, ChangeId, Identity, RepoPath, Revision},
};

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

impl ToNapiValue for Revision {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        unsafe { String::to_napi_value(env, val.to_string()) }
    }
}

impl FromNapiValue for Revision {
    unsafe fn from_napi_value(env: sys::napi_env, val: sys::napi_value) -> napi::Result<Self> {
        Ok(Self(unsafe { String::from_napi_value(env, val)? }.parse().map_err(Error::from)?))
    }
}

#[napi]
pub fn changes(dir: String) -> napi::Result<Vec<ChangeId>> {
    Ok(Cabaret::open(&dir)?.changes()?)
}

#[napi]
pub fn current_change(dir: String) -> napi::Result<ChangeId> {
    Ok(Cabaret::open(&dir)?.current_change()?)
}

#[napi]
pub fn change(dir: String, id: ChangeId) -> napi::Result<Change> {
    Ok(Cabaret::open(&dir)?.change(&id)?)
}

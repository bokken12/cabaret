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
    log::Log,
    render::{RenderedHome, render_home},
    revision::Revision,
    types::{ChangeId, Identity, RepoPath},
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

#[napi(js_name = "Cabaret")]
pub struct CabaretJs {
    cabaret: Cabaret,
}

#[napi]
impl CabaretJs {
    #[napi(constructor)]
    pub fn new(dir: String) -> napi::Result<Self> { Ok(Self { cabaret: Cabaret::open(&dir)? }) }

    #[napi]
    pub fn changes(&self) -> napi::Result<Vec<ChangeId>> { Ok(self.cabaret.changes()?) }

    #[napi]
    pub fn current_change(&self) -> napi::Result<ChangeId> { Ok(self.cabaret.current_change()?) }

    #[napi]
    pub fn log(&self, id: ChangeId) -> napi::Result<Log> { Ok(self.cabaret.log(&id)?) }

    #[napi]
    pub fn land(&self, change: ChangeId) -> napi::Result<()> { Ok(self.cabaret.land(&change)?) }

    #[napi]
    pub fn rebase(&self, change: ChangeId, onto: ChangeId) -> napi::Result<()> {
        Ok(self.cabaret.rebase(&change, &onto)?)
    }

    /// The rendered home view for `viewer`, defaulting to git's user.email.
    #[napi]
    pub fn home(&self, viewer: Option<Identity>) -> napi::Result<RenderedHome> {
        let viewer = match viewer {
            Some(viewer) => viewer,
            None => self.cabaret.identity()?,
        };
        Ok(render_home(&self.cabaret.home_graph(&viewer)?)?)
    }
}

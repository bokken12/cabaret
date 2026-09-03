// The napi boundary requires owned values for JS primitives.
#![allow(clippy::needless_pass_by_value)]

use std::sync::Arc;

use napi::{
    bindgen_prelude::{FromNapiValue, ToNapiValue, spawn_blocking},
    sys,
};
use napi_derive::napi;

use crate::{
    cabaret::{Cabaret, Rebase},
    error::{Error, Result},
    page::Page,
    types::{ChangeId, ChangeSnapshot, Identity, RepoPath, Revision, WorkspaceId},
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

impl ToNapiValue for WorkspaceId {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        unsafe { String::to_napi_value(env, val.to_string()) }
    }
}

#[napi(js_name = "Cabaret")]
pub struct CabaretJs {
    cabaret: Arc<Cabaret>,
}

impl CabaretJs {
    /// Runs `f` off the JS thread; gix work blocks on I/O and object decoding.
    async fn blocking<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Cabaret) -> Result<T> + Send + 'static,
    ) -> napi::Result<T> {
        let cabaret = Arc::clone(&self.cabaret);
        let result = spawn_blocking(move || f(&cabaret)).await;
        Ok(result.map_err(|panic| napi::Error::from_reason(panic.to_string()))??)
    }
}

#[napi]
impl CabaretJs {
    #[napi(constructor)]
    pub fn new(dir: String) -> napi::Result<Self> { Ok(Self { cabaret: Arc::new(Cabaret::open(&dir)?) }) }

    #[napi]
    pub async fn changes(&self) -> napi::Result<Vec<ChangeId>> { self.blocking(Cabaret::changes).await }

    #[napi]
    pub async fn current_change(&self) -> napi::Result<ChangeId> { self.blocking(Cabaret::current_change).await }

    #[napi]
    pub async fn change(&self, id: ChangeId) -> napi::Result<ChangeSnapshot> {
        self.blocking(move |cabaret| cabaret.snapshot(&id)).await
    }

    #[napi]
    pub async fn base(&self, change: ChangeId) -> napi::Result<Option<Revision>> {
        self.blocking(move |cabaret| cabaret.base(&change)).await
    }

    #[napi]
    pub async fn show_page(&self, change: ChangeId) -> napi::Result<Page> {
        self.blocking(move |cabaret| cabaret.show_page(&change)).await
    }

    #[napi]
    pub async fn diff_page(&self, change: ChangeId) -> napi::Result<Page> {
        self.blocking(move |cabaret| cabaret.diff_page(&change, &[])).await
    }

    /// The home page for `viewer`, defaulting to git's user.email.
    #[napi]
    pub async fn home_page(&self, viewer: Option<Identity>) -> napi::Result<Page> {
        self.blocking(move |cabaret| {
            let viewer = match viewer {
                Some(viewer) => viewer,
                None => cabaret.identity()?,
            };
            cabaret.home_page(&viewer)
        })
        .await
    }

    #[napi]
    pub async fn blob(&self, revision: Revision, path: RepoPath) -> napi::Result<Option<String>> {
        self.blocking(move |cabaret| cabaret.blob(revision, &path)).await
    }

    #[napi]
    pub async fn land(&self, change: ChangeId) -> napi::Result<ChangeId> {
        self.blocking(move |cabaret| cabaret.land(&change)).await
    }

    #[napi]
    pub async fn rebase(&self, change: ChangeId, onto: Option<ChangeId>) -> napi::Result<Rebase> {
        self.blocking(move |cabaret| cabaret.rebase(&change, onto.as_deref())).await
    }
}

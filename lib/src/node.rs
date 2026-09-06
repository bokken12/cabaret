// The napi boundary requires owned values for JS primitives.
// TODO-someday(joel): move js wrapper to a separate crate?
#![allow(clippy::needless_pass_by_value)]

use std::{collections::BTreeSet, path::PathBuf, sync::Arc};

use cabaret_types::{
    ChangeId, ChangeIdRef, ChangeSnapshot, ChangedFile, Identity, RepoPath, Result, Revision, WorkspaceId,
};
use napi::bindgen_prelude::spawn_blocking;
use napi_derive::napi;

use crate::{
    cabaret::{Cabaret, Rebase},
    page::Page,
};

/// The workspace holding `change`, which the workspace commands act on.
fn holding(cabaret: &Cabaret, change: &ChangeIdRef) -> Result<WorkspaceId> {
    cabaret.workspace_holding(change)?.ok_or_else(|| format!("{change} is not checked out in any workspace").into())
}

fn path_string(path: PathBuf) -> Result<String> {
    path.into_os_string().into_string().map_err(|path| format!("{} is not UTF-8", PathBuf::from(path).display()).into())
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
    pub async fn children(&self, change: ChangeId) -> napi::Result<BTreeSet<ChangeId>> {
        self.blocking(move |cabaret| cabaret.children(&change)).await
    }

    #[napi]
    pub async fn base(&self, change: ChangeId) -> napi::Result<Option<Revision>> {
        self.blocking(move |cabaret| cabaret.base(&change)).await
    }

    #[napi]
    pub async fn changed_files(&self, change: ChangeId) -> napi::Result<Vec<ChangedFile>> {
        self.blocking(move |cabaret| cabaret.changed_files(&change, &[])).await
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

    /// Create a workspace holding `change` at the default location, returning its path.
    #[napi]
    pub async fn workspace_add(&self, change: ChangeId) -> napi::Result<String> {
        self.blocking(move |cabaret| path_string(cabaret.workspace_add(change, None)?)).await
    }

    #[napi]
    pub async fn workspace_remove(&self, change: ChangeId) -> napi::Result<()> {
        self.blocking(move |cabaret| cabaret.workspace_remove(holding(cabaret, &change)?.to_ref())).await
    }

    #[napi]
    pub async fn workspace_path(&self, change: ChangeId) -> napi::Result<String> {
        self.blocking(move |cabaret| path_string(cabaret.workspace_path(holding(cabaret, &change)?.to_ref())?)).await
    }

    #[napi]
    pub async fn commit(&self, change: ChangeId) -> napi::Result<Revision> {
        self.blocking(move |cabaret| cabaret.commit(&change, &[])).await
    }

    /// Create `change` as a child of `parent`, owned by git's user.email.
    #[napi]
    pub async fn create(&self, change: ChangeId, parent: ChangeId) -> napi::Result<()> {
        self.blocking(move |cabaret| cabaret.create(&change, &parent, &cabaret.identity()?)).await
    }

    /// Insert `parent` between `change` and its parents, owned by git's user.email.
    #[napi]
    pub async fn create_parent(&self, change: ChangeId, parent: ChangeId) -> napi::Result<()> {
        self.blocking(move |cabaret| cabaret.create_parent(&change, &parent, &cabaret.identity()?)).await
    }

    #[napi]
    pub async fn land(&self, change: ChangeId) -> napi::Result<ChangeId> {
        self.blocking(move |cabaret| cabaret.land(&change)).await
    }

    #[napi]
    pub async fn toggle_archived(&self, change: ChangeId) -> napi::Result<bool> {
        self.blocking(move |cabaret| cabaret.toggle_archived(&change)).await
    }

    #[napi]
    pub async fn rebase(&self, change: ChangeId, onto: Option<ChangeId>) -> napi::Result<Rebase> {
        self.blocking(move |cabaret| cabaret.rebase(&change, onto.as_deref())).await
    }
}

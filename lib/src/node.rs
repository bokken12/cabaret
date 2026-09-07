// The napi boundary requires owned values for JS primitives.
// TODO-someday(joel): move js wrapper to a separate crate?
#![allow(clippy::needless_pass_by_value)]

use std::{collections::BTreeSet, path::PathBuf, sync::Arc};

use cabaret_agents::ClaudeCode;
use cabaret_types::{
    ChangeId, ChangeIdRef, ChangeSnapshot, ChangedFile, Identity, RepoPath, Result, RevisionId, WorkspaceId,
};
use napi::bindgen_prelude::spawn_blocking;
use napi_derive::napi;
use nonempty_collections::NEBTreeSet;

use crate::{
    cabaret::{Cabaret, Rebase},
    page::Page,
};

/// How the workspace a [`Cabaret`] was opened in reaches a change's files.
#[derive(Debug, Clone, PartialEq, Eq)]
#[napi(discriminant = "kind", object_from_js = false)]
pub enum Placement {
    /// The change is checked out here.
    Here,
    /// The change is checked out in another workspace.
    Elsewhere { workspace: WorkspaceId },
    /// The change is checked out nowhere. This workspace could switch to it, unless it is
    /// dedicated to the change it holds; see [`Cabaret::workspace_is_dedicated`].
    Nowhere { dedicated: bool },
}

fn placement(cabaret: &Cabaret, change: &ChangeIdRef) -> Result<Placement> {
    let current = cabaret.workspace_current()?;
    Ok(match cabaret.workspace_holding(change)? {
        Some(workspace) if workspace == current => Placement::Here,
        Some(workspace) => Placement::Elsewhere { workspace },
        None => Placement::Nowhere { dedicated: cabaret.workspace_is_dedicated(current.to_ref())? },
    })
}

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
    pub async fn base(&self, change: ChangeId) -> napi::Result<Option<RevisionId>> {
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

    /// Start a Claude Code session on `prompt` in the workspace holding `change`, returning once
    /// it is running. `args` go to the CLI ahead of the prompt.
    #[napi]
    pub async fn start_session(&self, change: ChangeId, prompt: String, args: Vec<String>) -> napi::Result<()> {
        self.blocking(move |cabaret| cabaret.start_session(&change, &prompt, &args, &ClaudeCode::locate()?)).await
    }

    /// The Claude Code sessions launched in the workspace holding `change`, as the tail of its
    /// show page.
    #[napi]
    pub async fn sessions_page(&self, change: ChangeId) -> napi::Result<Page> {
        self.blocking(move |cabaret| cabaret.sessions_page(&change, &ClaudeCode::locate()?)).await
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
    pub async fn blob(&self, revision_id: RevisionId, path: RepoPath) -> napi::Result<Option<String>> {
        self.blocking(move |cabaret| cabaret.blob(revision_id, &path)).await
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
    pub async fn placement(&self, change: ChangeId) -> napi::Result<Placement> {
        self.blocking(move |cabaret| placement(cabaret, &change)).await
    }

    /// Check `change` out in the workspace this instance was opened in.
    #[napi]
    pub async fn workspace_switch(&self, change: ChangeId) -> napi::Result<()> {
        self.blocking(move |cabaret| cabaret.workspace_switch(cabaret.workspace_current()?.to_ref(), change)).await
    }

    #[napi]
    pub async fn commit(&self, change: ChangeId) -> napi::Result<RevisionId> {
        self.blocking(move |cabaret| cabaret.commit(&change, &[])).await
    }

    /// Create `change` as a child of `parent`, owned by git's user.email.
    #[napi]
    pub async fn create(&self, change: ChangeId, parent: ChangeId) -> napi::Result<()> {
        self.blocking(move |cabaret| cabaret.create(&change, NEBTreeSet::new(parent), &cabaret.identity()?)).await
    }

    /// Create `change` as a parent of `child`, owned by git's user.email.
    #[napi]
    pub async fn create_parent(&self, change: ChangeId, child: ChangeId) -> napi::Result<()> {
        self.blocking(move |cabaret| cabaret.create_parent(&change, &child, &cabaret.identity()?)).await
    }

    #[napi]
    pub async fn add_owner(&self, change: ChangeId, owner: Identity) -> napi::Result<()> {
        self.blocking(move |cabaret| cabaret.add_owner(&change, &owner)).await
    }

    #[napi]
    pub async fn remove_owner(&self, change: ChangeId, owner: Identity) -> napi::Result<()> {
        self.blocking(move |cabaret| cabaret.remove_owner(&change, &owner)).await
    }

    #[napi]
    pub async fn add_parent(&self, change: ChangeId, parent: ChangeId) -> napi::Result<()> {
        self.blocking(move |cabaret| cabaret.add_parent(&change, &parent)).await
    }

    #[napi]
    pub async fn remove_parent(&self, change: ChangeId, parent: ChangeId) -> napi::Result<()> {
        self.blocking(move |cabaret| cabaret.remove_parent(&change, &parent)).await
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

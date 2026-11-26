// The napi boundary requires owned values for JS primitives.
// TODO-someday(joel): move js wrapper to a separate crate?
#![allow(clippy::needless_pass_by_value)]

use std::{
    collections::{BTreeSet, HashMap},
    path::PathBuf,
    sync::Arc,
};

use cabaret_config::FetchInterval;
use cabaret_page::{DiffView, HomeSection, Page, Route};
use cabaret_types::{
    ChangeId, ChangeIdRef, ChangeSnapshot, ChangedFile, Error, Identity, Pathspec, RepoPath, Result, RevisionId,
    ViewDiff, WorkspaceId, safeguard::SafeguardKind,
};
use napi::bindgen_prelude::{Either, spawn_blocking};
use napi_derive::napi;
use nonempty_collections::NEBTreeSet;

use crate::cabaret::{Cabaret, Rebase};

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

/// A [`cabaret_types::safeguard::Safeguard`] as a frontend presents it.
#[napi(object, object_from_js = false)]
pub struct Safeguard {
    pub kind: SafeguardKind,
    pub message: String,
}

/// The safeguards that refused an action.
#[napi(object, object_from_js = false)]
pub struct Refused {
    pub safeguards: Vec<Safeguard>,
}

/// Refusals as a value to present, other failures as the errors they are.
fn attempt<T>(result: Result<T>) -> Result<Either<T, Refused>> {
    match result {
        Ok(done) => Ok(Either::A(done)),
        Err(Error::Refused(refused)) => {
            let present = |safeguard: cabaret_types::safeguard::Safeguard| Safeguard {
                kind: SafeguardKind::from(&safeguard),
                message: safeguard.to_string(),
            };
            Ok(Either::B(Refused { safeguards: refused.into_iter().map(present).collect() }))
        }
        Err(error) => Err(error),
    }
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

    /// The title of every change that has one, by change id.
    #[napi]
    pub async fn titles(&self) -> napi::Result<HashMap<String, String>> {
        let titles = self.blocking(Cabaret::titles).await?;
        Ok(titles.into_iter().map(|(change, title)| (change.to_string(), title)).collect())
    }

    #[napi]
    pub async fn current_change(&self) -> napi::Result<ChangeId> { self.blocking(Cabaret::current_change).await }

    /// Git's user.email, as which this acts.
    #[napi]
    pub async fn identity(&self) -> napi::Result<Identity> { self.blocking(Cabaret::identity).await }

    #[napi]
    pub async fn trunk(&self) -> napi::Result<ChangeId> { self.blocking(Cabaret::trunk).await }

    #[napi]
    pub async fn change(&self, id: ChangeId) -> napi::Result<ChangeSnapshot> {
        self.blocking(move |cabaret| cabaret.snapshot(&id)).await
    }

    #[napi]
    pub async fn children(&self, change: ChangeId) -> napi::Result<BTreeSet<ChangeId>> {
        self.blocking(move |cabaret| cabaret.children(&change)).await
    }

    /// The page `route` names, as git's user.email sees it.
    #[napi]
    pub async fn page(&self, route: Route) -> napi::Result<Page> {
        self.blocking(move |cabaret| cabaret.page(&route)).await
    }

    /// The files `change`'s `view` diffs; for review, those git's user.email has left to read.
    #[napi]
    pub async fn view_files(&self, change: ChangeId, view: DiffView) -> napi::Result<Vec<ChangedFile>> {
        self.blocking(move |cabaret| cabaret.view_files(&change, view, &[])).await
    }

    /// The first section of git's user.email's home page with changes in it.
    #[napi]
    pub async fn first_home_section(&self) -> napi::Result<HomeSection> {
        self.blocking(|cabaret| cabaret.first_home_section(&cabaret.identity()?)).await
    }

    /// The text of `path` at `revision_id`, or `None` when no file is there.
    // TODO-someday(joel): binary files
    #[napi]
    pub async fn blob(&self, revision_id: RevisionId, path: RepoPath) -> napi::Result<Option<String>> {
        self.blocking(move |cabaret| match cabaret.blob(revision_id, &path)? {
            Some(version) => Ok(Some(String::from_utf8(version.data.into())?)),
            None => Ok(None),
        })
        .await
    }

    /// The files `change`'s `view` diffs among `paths`, with the revisions holding both sides of
    /// each; for review, those git's user.email has left to read.
    #[napi]
    pub async fn view_diff(&self, change: ChangeId, view: DiffView, paths: Vec<RepoPath>) -> napi::Result<ViewDiff> {
        let pathspecs: Vec<Pathspec> = paths.iter().map(Pathspec::literal).collect();
        self.blocking(move |cabaret| cabaret.view_diff(&change, view, &pathspecs)).await
    }

    /// Create a workspace holding `change` at the default location, returning its path.
    #[napi]
    pub async fn workspace_add(&self, change: ChangeId) -> napi::Result<String> {
        self.blocking(move |cabaret| path_string(cabaret.workspace_add(&change, None)?)).await
    }

    #[napi]
    pub async fn workspace_remove(
        &self,
        change: ChangeId,
        allow: BTreeSet<SafeguardKind>,
    ) -> napi::Result<Either<(), Refused>> {
        self.blocking(move |cabaret| attempt(cabaret.workspace_remove(cabaret.workspace_of(&change)?.to_ref(), &allow)))
            .await
    }

    /// Seconds between background fetches from origin, or `None` for never.
    #[napi]
    pub fn fetch_interval(&self) -> napi::Result<Option<u32>> {
        Ok(match self.cabaret.config::<FetchInterval>()?.unwrap_or_default() {
            FetchInterval::Never => None,
            FetchInterval::Seconds(seconds) => Some(seconds.get()),
        })
    }

    #[napi]
    pub fn has_origin(&self) -> bool { self.cabaret.has_origin() }

    // TODO-someday(joel): show the editor which branches fetch kept apart from origin's
    #[napi]
    pub async fn fetch(&self) -> napi::Result<()> { self.blocking(|cabaret| cabaret.fetch().map(drop)).await }

    #[napi]
    pub fn common_dir(&self) -> napi::Result<String> { Ok(path_string(self.cabaret.common_dir())?) }

    #[napi]
    pub async fn workspace_path(&self, change: ChangeId) -> napi::Result<String> {
        self.blocking(move |cabaret| path_string(cabaret.workspace_path(cabaret.workspace_of(&change)?.to_ref())?))
            .await
    }

    /// Whether the workspace holding `change` is that change's own rather than one to switch between changes.
    #[napi]
    pub async fn workspace_is_dedicated(&self, change: ChangeId) -> napi::Result<bool> {
        self.blocking(move |cabaret| cabaret.workspace_is_dedicated(cabaret.workspace_of(&change)?.to_ref())).await
    }

    #[napi]
    pub async fn placement(&self, change: ChangeId) -> napi::Result<Placement> {
        self.blocking(move |cabaret| placement(cabaret, &change)).await
    }

    /// Check `change` out in the workspace this instance was opened in.
    #[napi]
    pub async fn workspace_switch(
        &self,
        change: ChangeId,
        allow: BTreeSet<SafeguardKind>,
    ) -> napi::Result<Either<(), Refused>> {
        self.blocking(move |cabaret| {
            attempt(cabaret.workspace_switch(cabaret.workspace_current()?.to_ref(), &change, &allow))
        })
        .await
    }

    /// Commit `files` of `change`'s workspace diff, or all of it when empty. Both sides of a
    /// rename go, so the move is committed rather than a copy.
    #[napi]
    pub async fn commit(
        &self,
        change: ChangeId,
        files: Vec<ChangedFile>,
        allow: BTreeSet<SafeguardKind>,
    ) -> napi::Result<Either<RevisionId, Refused>> {
        let pathspecs: Vec<Pathspec> = files.iter().flat_map(ChangedFile::paths).map(Pathspec::literal).collect();
        self.blocking(move |cabaret| attempt(cabaret.commit(&change, &pathspecs, &allow))).await
    }

    /// Discard `files` of `change`'s workspace diff, or all of it when empty. Both sides of a
    /// rename go, so the moved file returns to where it was.
    #[napi]
    pub async fn discard(&self, change: ChangeId, files: Vec<ChangedFile>) -> napi::Result<()> {
        let pathspecs: Vec<Pathspec> = files.iter().flat_map(ChangedFile::paths).map(Pathspec::literal).collect();
        self.blocking(move |cabaret| cabaret.discard(&change, &pathspecs)).await
    }

    /// Create a change named `name` as a child of `parent`, owned by git's user.email.
    #[napi]
    pub async fn create(
        &self,
        name: String,
        parent: ChangeId,
        allow: BTreeSet<SafeguardKind>,
    ) -> napi::Result<Either<ChangeId, Refused>> {
        self.blocking(move |cabaret| {
            let parents = NEBTreeSet::new(parent);
            attempt(cabaret.create(&name, &parents, &cabaret.identity()?, &allow))
        })
        .await
    }

    // TODO(joel): add allow?
    /// Create a change named `name` as a parent of `child`, owned by git's user.email, returning its id.
    #[napi]
    pub async fn create_parent(&self, name: String, child: ChangeId) -> napi::Result<ChangeId> {
        self.blocking(move |cabaret| cabaret.create_parent(&name, &child, &cabaret.identity()?, &BTreeSet::new())).await
    }

    #[napi]
    pub async fn add_owner(&self, change: ChangeId, owner: Identity) -> napi::Result<()> {
        self.blocking(move |cabaret| cabaret.add_owner(&change, &owner)).await
    }

    #[napi]
    pub async fn remove_owner(
        &self,
        change: ChangeId,
        owner: Identity,
        allow: BTreeSet<SafeguardKind>,
    ) -> napi::Result<Either<(), Refused>> {
        self.blocking(move |cabaret| attempt(cabaret.remove_owner(&change, &owner, &allow))).await
    }

    #[napi]
    pub async fn add_parent(
        &self,
        change: ChangeId,
        parent: ChangeId,
        allow: BTreeSet<SafeguardKind>,
    ) -> napi::Result<Either<(), Refused>> {
        self.blocking(move |cabaret| attempt(cabaret.add_parent(&change, &parent, &allow))).await
    }

    #[napi]
    pub async fn remove_parent(
        &self,
        change: ChangeId,
        parent: ChangeId,
        allow: BTreeSet<SafeguardKind>,
    ) -> napi::Result<Either<(), Refused>> {
        self.blocking(move |cabaret| attempt(cabaret.remove_parent(&change, &parent, &allow))).await
    }

    /// Record that git's user.email has reviewed `files` of `change` up to `head`, defaulting to
    /// its tip.
    #[napi]
    pub async fn mark(&self, change: ChangeId, files: Vec<RepoPath>, head: Option<RevisionId>) -> napi::Result<()> {
        let pathspecs: Vec<Pathspec> = files.iter().map(Pathspec::literal).collect();
        self.blocking(move |cabaret| cabaret.mark(&change, &pathspecs, head).map(drop)).await
    }

    #[napi]
    pub async fn endorse(&self, change: ChangeId, allow: BTreeSet<SafeguardKind>) -> napi::Result<Either<(), Refused>> {
        self.blocking(move |cabaret| attempt(cabaret.endorse(&change, &allow))).await
    }

    #[napi]
    pub async fn unendorse(&self, change: ChangeId) -> napi::Result<()> {
        self.blocking(move |cabaret| cabaret.unendorse(&change)).await
    }

    #[napi]
    pub async fn set_title(&self, change: ChangeId, title: Option<String>) -> napi::Result<()> {
        self.blocking(move |cabaret| cabaret.set_title(&change, title)).await
    }

    #[napi]
    pub async fn set_description(&self, change: ChangeId, description: Option<String>) -> napi::Result<()> {
        self.blocking(move |cabaret| cabaret.set_description(&change, description)).await
    }

    #[napi]
    pub async fn land(
        &self,
        change: ChangeId,
        allow: BTreeSet<SafeguardKind>,
    ) -> napi::Result<Either<ChangeId, Refused>> {
        self.blocking(move |cabaret| attempt(cabaret.land(&change, &allow))).await
    }

    #[napi]
    pub async fn archive(&self, change: ChangeId, allow: BTreeSet<SafeguardKind>) -> napi::Result<Either<(), Refused>> {
        self.blocking(move |cabaret| attempt(cabaret.archive(&change, &allow))).await
    }

    #[napi]
    pub async fn unarchive(
        &self,
        change: ChangeId,
        allow: BTreeSet<SafeguardKind>,
    ) -> napi::Result<Either<(), Refused>> {
        self.blocking(move |cabaret| attempt(cabaret.unarchive(&change, &allow))).await
    }

    #[napi]
    pub async fn rebase(
        &self,
        change: ChangeId,
        onto: Option<ChangeId>,
        allow: BTreeSet<SafeguardKind>,
    ) -> napi::Result<Either<Rebase, Refused>> {
        self.blocking(move |cabaret| attempt(cabaret.rebase(&change, onto.as_deref(), &allow))).await
    }
}

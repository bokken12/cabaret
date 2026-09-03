use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use gix::ThreadSafeRepository;

use crate::{
    change::ChangeSnapshot,
    error::Result,
    page::Page,
    types::{ChangeId, ChangeIdRef, ChangedFile, Identity, Pathspec, RepoPath, Revision, WorkspaceId},
};

/// What [`Cabaret::rebase`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "napi", napi_derive::napi(object, object_from_js = false))]
pub struct Rebase {
    /// The parents merged in; empty when the change already contained them all.
    pub merged: BTreeSet<ChangeId>,
    /// Files the last merge left holding conflict markers, which stopped the rebase there.
    pub conflicts: BTreeSet<RepoPath>,
    /// Parents not reached because of the conflicts; rebasing again after resolving them continues.
    pub remaining: BTreeSet<ChangeId>,
}

/// Cabaret provides the external-facing interface, with actions at the level a porcelain performs.
pub struct Cabaret {
    pub(crate) repo: ThreadSafeRepository,
}

impl Cabaret {
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> { Ok(Self { repo: ThreadSafeRepository::discover(dir)? }) }

    pub fn changes(&self) -> Result<Vec<ChangeId>> { self.query(|ctx| ctx.changes()) }

    pub fn identity(&self) -> Result<Identity> { self.query(|ctx| ctx.identity()) }

    pub fn current_change(&self) -> Result<ChangeId> { self.query(|ctx| ctx.current_change()) }

    /// Every workspace and the change checked out in it, `None` where HEAD is detached.
    pub fn workspaces(&self) -> Result<BTreeMap<WorkspaceId, Option<ChangeId>>> {
        self.query(|ctx| {
            let mut workspaces = BTreeMap::new();
            for workspace in ctx.workspaces()? {
                let change = ctx.workspace_change(&workspace)?;
                workspaces.insert(workspace, change);
            }
            Ok(workspaces)
        })
    }

    pub fn snapshot(&self, change_id: &ChangeIdRef) -> Result<ChangeSnapshot> {
        self.query(|ctx| ctx.read(change_id)?.snapshot())
    }

    pub fn blob(&self, revision: Revision, path: &RepoPath) -> Result<Option<String>> {
        self.query(|ctx| ctx.blob(revision, path))
    }

    pub fn base(&self, change_id: &ChangeIdRef) -> Result<Option<Revision>> {
        self.query(|ctx| ctx.read(change_id)?.base())
    }

    pub fn changed_files(&self, change_id: &ChangeIdRef, pathspecs: &[Pathspec]) -> Result<Vec<ChangedFile>> {
        self.query(|ctx| ctx.read(change_id)?.changed_files(pathspecs))
    }

    pub fn show_page(&self, change_id: &ChangeIdRef) -> Result<Page> {
        Ok(Page::show(change_id, &self.snapshot(change_id)?))
    }

    pub fn diff_page(&self, change_id: &ChangeIdRef, pathspecs: &[Pathspec]) -> Result<Page> {
        Ok(Page::diff(change_id, &self.changed_files(change_id, pathspecs)?))
    }

    pub fn create(&self, change_id: &ChangeIdRef, parent_id: &ChangeIdRef, owner: &Identity) -> Result<()> {
        let tip = self.query(|ctx| Ok(ctx.read(parent_id)?.tip()))?;
        self.insert1(change_id, tip, |_ctx, change| {
            change.declared_parents = BTreeSet::from([parent_id.to_owned()]);
            change.owners = BTreeSet::from([owner.clone()]);
            Ok(())
        })
    }

    /// Merge `change_id` into its one parent and archive it unless it is permanent, returning the
    /// parent. Conflicts are refused rather than landed: rebase and resolve them first.
    pub fn land(&self, change_id: &ChangeIdRef) -> Result<ChangeId> {
        let parent_id = self.query(|ctx| {
            let change = ctx.read(change_id)?;
            match change.parents()?.iter().collect::<Vec<_>>().as_slice() {
                [] => Err(format!("{change_id} cannot land while it has no parents"))?,
                [_, _, ..] => Err(format!("{change_id} cannot land while it has multiple parents"))?,
                [parent] => Ok((*parent).clone()),
            }
        })?;
        self.update(&[change_id, &parent_id], |_ctx, [change, parent]| {
            if change.archived {
                Err(format!("{change_id} is archived"))?;
            }
            match parent.merge(change, "land")? {
                None => Err(format!("{change_id} has nothing to land"))?,
                Some(conflicts) if !conflicts.is_empty() => {
                    Err(format!("{change_id} conflicts with {parent_id}; rebase and resolve first"))?;
                }
                Some(_) => {}
            }
            if !change.permanent {
                change.archived = true;
            }
            Ok(parent_id.clone())
        })
    }

    /// Bring `change_id` up to date with `onto`, or with every parent when `onto` is `None`.
    /// Cabaret never rewrites history, so each parent's tip is merged in; a conflicting merge is
    /// committed with markers and stops the rebase there, so those are resolved before the next.
    pub fn rebase(&self, change_id: &ChangeIdRef, onto: Option<&ChangeIdRef>) -> Result<Rebase> {
        self.update1(change_id, |ctx, change| {
            let parents = change.parents()?;
            let targets = match onto {
                None if parents.is_empty() => Err(format!("{change_id} has no parents to rebase onto"))?,
                None => parents,
                Some(onto) if parents.contains(onto) => BTreeSet::from([onto.to_owned()]),
                Some(onto) => Err(format!("{onto} is not a parent of {change_id}"))?,
            };

            let mut rebase = Rebase { merged: BTreeSet::new(), conflicts: BTreeSet::new(), remaining: BTreeSet::new() };
            let mut targets = targets.into_iter();
            for parent_id in targets.by_ref() {
                if let Some(conflicts) = change.merge(ctx.read(&parent_id)?, "rebase")? {
                    rebase.merged.insert(parent_id);
                    rebase.conflicts = conflicts;
                    if !rebase.conflicts.is_empty() {
                        break;
                    }
                }
            }
            rebase.remaining = targets.collect();
            Ok(rebase)
        })
    }

    pub fn archive(&self, change_id: &ChangeIdRef) -> Result<()> {
        self.update1(change_id, |_ctx, change| {
            // TODO(joel): warn if children unarchived?
            match change.archived {
                true => Err(format!("{change_id} has already been archived"))?,
                false => change.archived = true,
            };
            Ok(())
        })
    }

    pub fn unarchive(&self, change_id: &ChangeIdRef) -> Result<()> {
        self.update1(change_id, |_ctx, change| {
            // TODO(joel): warn if parents archived?
            match change.archived {
                false => Err(format!("{change_id} has not been archived"))?,
                true => change.archived = false,
            };
            Ok(())
        })
    }

    pub fn add_owner(&self, change_id: &ChangeIdRef, owner: &Identity) -> Result<()> {
        self.update1(change_id, |_ctx, change| match change.owners.insert(owner.clone()) {
            false => Err(format!("{owner} already owned {change_id}"))?,
            true => Ok(()),
        })
    }

    pub fn remove_owner(&self, change_id: &ChangeIdRef, owner: &Identity) -> Result<()> {
        self.update1(change_id, |_ctx, change| match change.owners.remove(owner) {
            false => Err(format!("{owner} did not own {change_id}"))?,
            true if change.owners.len() == 0 => Err(format!("{owner} was {change_id}'s only owner"))?,
            true => Ok(()),
        })
    }

    pub fn set_owners(&self, change_id: &ChangeIdRef, owners: BTreeSet<Identity>) -> Result<()> {
        self.update1(change_id, |_ctx, change| match change.owners == owners {
            true => Err(format!("{change_id} already had these owners"))?,
            false if owners.len() == 0 => Err(format!("{change_id} should have at least one owner"))?,
            false => Ok(change.owners = owners),
        })
    }

    // TODO(joel): some helper that aligns the parent set with the derived parent set?

    pub fn add_parent(&self, change_id: &ChangeIdRef, parent_id: &ChangeIdRef) -> Result<()> {
        self.update1(change_id, |ctx, change| {
            // TODO(joel): check for cyclic dependencies
            match change.declared_parents.insert(parent_id.to_owned()) {
                false => Err(format!("{parent_id} was already a parent of {change_id}"))?,
                true => Ok(()),
            }
        })
    }

    pub fn remove_parent(&self, change_id: &ChangeIdRef, parent_id: &ChangeIdRef) -> Result<()> {
        self.update1(change_id, |_ctx, change| match change.declared_parents.remove(parent_id) {
            false => Err(format!("{parent_id} was not a parent of {change_id}"))?,
            true => Ok(()),
        })
    }

    pub fn set_title(&self, change_id: &ChangeIdRef, title: Option<String>) -> Result<()> {
        self.update1(change_id, |_ctx, change| match change.title == title {
            true => Err(format!("{change_id} already had this title"))?,
            false => Ok(change.title = title),
        })
    }

    pub fn set_description(&self, change_id: &ChangeIdRef, description: Option<String>) -> Result<()> {
        self.update1(change_id, |_ctx, change| match change.description == description {
            true => Err(format!("{change_id} already had this description"))?,
            false => Ok(change.description = description),
        })
    }

    pub fn set_permanent(&self, change_id: &ChangeIdRef, permanent: bool) -> Result<()> {
        self.update1(change_id, |_ctx, change| {
            // TODO(joel): warn if parents non-permanent?
            match change.archived {
                true => Err(format!("{change_id} is archived"))?,
                _ => change.permanent = permanent,
            };
            Ok(())
        })
    }
}

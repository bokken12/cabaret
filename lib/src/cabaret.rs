use std::{collections::BTreeSet, path::Path};

use gix::ThreadSafeRepository;

use crate::{
    change::ChangeSnapshot,
    error::Result,
    types::{ChangeId, ChangeIdRef, ChangedFile, Identity, Pathspec, RepoPath, Revision},
};

/// Cabaret provides the external-facing interface, with actions at the level a porcelain performs.
pub struct Cabaret {
    pub(crate) repo: ThreadSafeRepository,
}

impl Cabaret {
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> { Ok(Self { repo: ThreadSafeRepository::discover(dir)? }) }

    pub fn changes(&self) -> Result<Vec<ChangeId>> { self.query(|ctx| ctx.changes()) }

    pub fn identity(&self) -> Result<Identity> { self.query(|ctx| ctx.identity()) }

    pub fn current_change(&self) -> Result<ChangeId> { self.query(|ctx| ctx.current_change()) }

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

    pub fn create(&self, change_id: &ChangeIdRef, parent_id: &ChangeIdRef, owner: &Identity) -> Result<()> {
        let tip = self.query(|ctx| Ok(ctx.read(parent_id)?.tip()))?;
        self.insert1(change_id, tip, |_ctx, change| {
            change.declared_parents = BTreeSet::from([parent_id.to_owned()]);
            change.owners = BTreeSet::from([owner.clone()]);
            Ok(())
        })
    }

    fn land_into(&self, change_id: &ChangeIdRef, into_id: &ChangeIdRef) -> Result<()> {
        self.update(&[change_id, into_id], |_ctx, [change, into]| {
            // TODO
            Ok(())
        })
    }

    pub fn land(&self, change_id: &ChangeIdRef) -> Result<()> {
        let parent = self.query(|ctx| {
            let change = ctx.read(change_id)?;
            match change.parents()?.iter().collect::<Vec<_>>().as_slice() {
                [] => Err(format!("{change_id} cannot land while it has no parents"))?,
                [_, _, ..] => Err(format!("{change_id} cannot land while it has multiple parents"))?,
                [parent] => Ok((*parent).clone()),
            }
        })?;
        self.land_into(change_id, &parent)
    }

    pub fn rebase(&self, change_id: &ChangeIdRef, onto_id: &ChangeIdRef) -> Result<()> {
        self.update(&[change_id, onto_id], |_ctx, [change, onto]| {
            // TODO
            Ok(())
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

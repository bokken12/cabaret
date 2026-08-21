use std::{collections::BTreeSet, path::Path};

use gix::ThreadSafeRepository;

use crate::{
    change::{ChangeId, ChangeIdRef},
    error::Result,
    types::{Identity, Liveness},
};

pub struct Cabaret {
    pub(crate) repo: ThreadSafeRepository,
}

impl Cabaret {
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> { Ok(Self { repo: ThreadSafeRepository::discover(dir)? }) }

    pub fn changes(&self) -> Result<Vec<ChangeId>> { self.query(|ctx| ctx.changes()) }

    pub fn identity(&self) -> Result<Identity> { self.query(|ctx| ctx.identity()) }

    pub fn create(&self, change_id: &ChangeIdRef, parent_id: &ChangeIdRef, owner: &Identity) -> Result<()> {
        self.insert1(change_id, |_ctx, change| {
            change.parents = BTreeSet::from([parent_id.to_owned()]);
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
            let change = ctx.read(change_id);
            match change.parents.iter().collect::<Vec<_>>().as_slice() {
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
            match change.liveness {
                Liveness::Permanent => Err(format!("{change_id} is permanent and cannot be archived"))?,
                Liveness::Archived => Err(format!("{change_id} has already been archived"))?,
                Liveness::Live => change.liveness = Liveness::Archived,
            };
            Ok(())
        })
    }

    pub fn unarchive(&self, change_id: &ChangeIdRef) -> Result<()> {
        self.update1(change_id, |_ctx, change| {
            // TODO(joel): warn if parents archived?
            match change.liveness {
                Liveness::Live | Liveness::Permanent => Err(format!("{change_id} has not been archived"))?,
                Liveness::Archived => change.liveness = Liveness::Live,
            };
            Ok(())
        })
    }

    pub fn set_permanent(&self, change_id: &ChangeIdRef, permanent: bool) -> Result<()> {
        self.update1(change_id, |_ctx, change| {
            // TODO(joel): warn if parents non-permanent?
            match change.liveness {
                Liveness::Archived => Err(format!("{change_id} is archived"))?,
                _ => change.liveness = if permanent { Liveness::Permanent } else { Liveness::Live },
            };
            Ok(())
        })
    }
}

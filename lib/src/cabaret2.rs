use std::collections::BTreeSet;

use gix::ThreadSafeRepository;

use crate::{change::ChangeIdRef, error::Result, types::Liveness};

pub struct Cabaret {
    pub repo: ThreadSafeRepository,
}

impl Cabaret {
    pub fn create(&self, change_id: &ChangeIdRef, parent_id: &ChangeIdRef) -> Result<()> {
        self.insert1(change_id, |_ctx, change| {
            change.parents = BTreeSet::from([parent_id.to_owned()]);
            Ok(())
        })
    }

    pub fn land_into(&self, change_id: &ChangeIdRef, into_id: &ChangeIdRef) -> Result<()> {
        self.update(&[change_id, into_id], |_ctx, [change, into]| {
            // TODO
            Ok(())
        })
    }

    pub fn rebase(&self, change_id: &ChangeIdRef, onto_id: &ChangeIdRef) -> Result<()> {
        self.update(&[change_id, onto_id], |_ctx, [change, onto]| {
            // TODO
            Ok(())
        })
    }

    pub fn set_archived(&self, change_id: &ChangeIdRef, archived: bool) -> Result<()> {
        self.update1(change_id, |_ctx, change| {
            // TODO(joel): warn if children unarchived?
            match change.liveness {
                Liveness::Permanent => Err(format!("{change_id} is permanent"))?,
                _ => change.liveness = if archived { Liveness::Archived } else { Liveness::Live },
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

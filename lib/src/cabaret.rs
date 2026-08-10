use std::path::Path;

use gix::Repository;

use crate::{
    error::{Error, Result},
    types::ChangeId,
};

pub struct Cabaret {
    pub repo: Repository,
}

impl Cabaret {
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> {
        let repo = gix::discover(dir).map_err(Error::new)?;
        Ok(Self { repo })
    }

    // TODO-someday(jm): consider pulling into state
    pub fn current_change(&self) -> Result<ChangeId> {
        let head = self.repo.head_name().map_err(Error::new)?.ok_or_else(|| Error::new("HEAD is detached"))?;
        Ok(ChangeId(head.shorten().to_string()))
    }
}

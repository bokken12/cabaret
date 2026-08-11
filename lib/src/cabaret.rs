use std::path::Path;

use gix::Repository;

use crate::{error::Result, types::ChangeId};

pub struct Cabaret {
    pub repo: Repository,
}

impl Cabaret {
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> {
        let repo = gix::discover(dir)?;
        Ok(Self { repo })
    }

    // TODO-someday(jm): fetch refs/cabaret/* too
    pub fn fetch(&self) -> Result<()> {
        let remote = self.repo.find_default_remote(gix::remote::Direction::Fetch).ok_or("no remote configured")??;
        remote
            .connect(gix::remote::Direction::Fetch)?
            .prepare_fetch(gix::progress::Discard, gix::remote::ref_map::Options::default())?
            .receive(gix::progress::Discard, &gix::interrupt::IS_INTERRUPTED)?;
        Ok(())
    }

    // TODO-someday(jm): consider pulling into state
    pub fn current_change(&self) -> Result<ChangeId> {
        let head = self.repo.head_name()?.ok_or("HEAD is detached")?;
        Ok(head.shorten().to_string().parse()?)
    }
}

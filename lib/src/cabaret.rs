use std::path::Path;

use gix::{Repository, bstr::ByteSlice};

use crate::{error::Result, types::ChangeId};

pub struct Cabaret {
    pub repo: Repository,
}

impl Cabaret {
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> {
        let repo = gix::discover(dir)?;
        Ok(Self { repo })
    }

    // TODO-someday(joel): fetch refs/cabaret/* too
    pub fn fetch(&self) -> Result<()> {
        let remote = self.repo.find_default_remote(gix::remote::Direction::Fetch).ok_or("no remote configured")??;
        remote
            .connect(gix::remote::Direction::Fetch)?
            .prepare_fetch(gix::progress::Discard, gix::remote::ref_map::Options::default())?
            .receive(gix::progress::Discard, &gix::interrupt::IS_INTERRUPTED)?;
        Ok(())
    }

    pub fn changes(&self) -> Result<Vec<ChangeId>> {
        let mut changes = Vec::new();
        for reference in self.repo.references()?.prefixed(ChangeId::LOG_REF_PREFIX)? {
            let reference = reference?;
            let name = reference.name().as_bstr();
            let change = name
                .strip_prefix(ChangeId::LOG_REF_PREFIX.as_bytes())
                .expect("prefixed iteration stays under the prefix");
            changes.push(change.to_str()?.parse()?);
        }
        Ok(changes)
    }

    // TODO-someday(joel): consider pulling into state
    pub fn current_change(&self) -> Result<ChangeId> {
        let head = self.repo.head_name()?.ok_or("HEAD is detached")?;
        Ok(head.shorten().to_string().parse()?)
    }
}

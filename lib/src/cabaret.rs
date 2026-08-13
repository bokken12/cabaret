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

    pub fn branches(&self) -> Result<Vec<ChangeId>> {
        let mut branches = Vec::new();
        for reference in self.repo.references()?.local_branches()? {
            branches.push(reference?.name().shorten().to_str()?.parse()?);
        }
        Ok(branches)
    }

    // TODO-someday(joel): consider pulling into state
    pub fn current_change(&self) -> Result<ChangeId> {
        let head = self.repo.head_name()?.ok_or("HEAD is detached")?;
        Ok(head.shorten().to_string().parse()?)
    }
}

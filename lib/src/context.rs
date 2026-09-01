use std::{fmt, process::Command};

use elsa::FrozenBTreeMap;
use gix::{Repository, bstr::ByteSlice};

use crate::{
    change::Change,
    error::Result,
    types::{ChangeId, ChangeIdRef, Identity, TimestampMs},
};

/// One transaction's view of the repository at a fixed time
pub struct TransactionContext<'ctx> {
    pub(crate) repo: Repository,
    pub timestamp: TimestampMs,
    read: FrozenBTreeMap<ChangeId, Box<Change<'ctx>>>,
}

impl<'ctx> fmt::Debug for TransactionContext<'ctx> {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result { todo!() }
}

impl<'ctx> TransactionContext<'ctx> {
    pub(crate) fn new(repo: Repository) -> Self {
        Self { repo, timestamp: TimestampMs::now(), read: FrozenBTreeMap::new() }
    }

    /// The state of `change_id` as of `self.timestamp`.
    pub fn read(&'ctx self, change_id: &ChangeIdRef) -> Result<&'ctx Change<'ctx>> {
        if let Some(change) = self.read.get(change_id) {
            return Ok(change);
        }

        let change = Change::from_log(self, change_id)?;
        Ok(self.read.insert(change_id.to_owned(), Box::new(change)))
    }

    pub fn changes(&self) -> Result<Vec<ChangeId>> {
        let mut changes = Vec::new();
        for reference in self.repo.references()?.prefixed(ChangeIdRef::LOG_REF_PREFIX)? {
            let reference = reference?;
            let name = reference.name().as_bstr();
            let change = name
                .strip_prefix(ChangeIdRef::LOG_REF_PREFIX.as_bytes())
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

    /// Git running against this repository, for operations gix does not implement yet.
    pub fn git_when_gix_unimplemented(&self) -> Command {
        let mut command = Command::new("git");
        command.arg("--git-dir").arg(self.repo.git_dir());
        command
    }

    /// The identity this repository acts as: git's user.email.
    pub fn identity(&self) -> Result<Identity> {
        let committer = self.repo.committer().ok_or("no git identity; set user.email")??;
        Ok(Identity(committer.email.to_string()))
    }

    // TODO-someday(joel): consider pulling into state
    pub fn current_change(&self) -> Result<ChangeId> {
        let head = self.repo.head_name()?.ok_or("HEAD is detached")?;
        Ok(head.shorten().to_string().parse()?)
    }
}

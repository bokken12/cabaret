use std::{collections::BTreeSet, path::Path, process::Command};

use elsa::FrozenBTreeMap;
use gix::{Repository, bstr::ByteSlice};

use crate::{
    cabaret2::Cabaret,
    change::{ChangeId, ChangeIdRef},
    error::Result,
    revision::Revision,
    types::{Identity, Liveness},
};

// Effectively all operations should work on immutable references
pub struct TransactionContext<'ctx> {
    repo: Repository,
    read: FrozenBTreeMap<ChangeId, Box<Change<'ctx>>>,
}

// impl Cabaret {
//     pub(crate) fn ctx(&self) -> TransactionContext {
//         TransactionContext { repo: self.repo.to_thread_local(), read: FrozenBTreeMap::new() }
//     }
// }

impl<'ctx> TransactionContext<'ctx> {
    pub fn read(&self, change_id: &ChangeIdRef) -> &Change<'ctx> {
        match self.read.get(change_id) {
            Some(read) => &read,
            None => {
                // TODO(joel): read from log
                let parse = Box::new(todo!());
                self.read.insert(change_id.to_owned(), parse)
            }
        }
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

// TODO(joel): move
// #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Change<'ctx> {
    ctx: &'ctx TransactionContext<'ctx>,
    head: Revision,
    pub title: String,
    pub description: String,
    // TODO(joel): consider splitting back out?
    pub liveness: Liveness,
    pub owners: BTreeSet<Identity>,
    pub parents: BTreeSet<ChangeId>,
}

// impl Change {
//     pub fn new() -> Self { todo!() }
// }

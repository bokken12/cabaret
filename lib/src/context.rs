use std::{collections::BTreeSet, process::Command};

use elsa::FrozenBTreeMap;
use gix::{Repository, bstr::ByteSlice};

use crate::{
    change_id::{ChangeId, ChangeIdRef},
    error::Result,
    revision::Revision,
    types::Identity,
};

// Effectively all operations should work on immutable references
pub struct TransactionContext<'ctx> {
    pub(crate) repo: Repository,
    read: FrozenBTreeMap<ChangeId, Box<Change<'ctx>>>,
}

// impl Cabaret {
//     pub(crate) fn ctx(&self) -> TransactionContext {
//         TransactionContext { repo: self.repo.to_thread_local(), read: FrozenBTreeMap::new() }
//     }
// }

impl<'ctx> TransactionContext<'ctx> {
    pub fn read(&self, change_id: &ChangeIdRef) -> Result<&Change<'ctx>> {
        match self.read.get(change_id) {
            Some(read) => Ok(&read),
            None => {
                // TODO(joel): read from log
                let parse = Box::new(todo!());
                Ok(self.read.insert(change_id.to_owned(), parse))
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
    id: ChangeId,
    tip: Revision,
    pub title: String,
    pub description: String,
    pub archived: bool,
    pub permanent: bool,
    pub owners: BTreeSet<Identity>,
    pub parents: BTreeSet<ChangeId>,
}

impl<'ctx> Change<'ctx> {
    pub fn is_descendant(&self, ancestor: &ChangeIdRef) -> Result<bool> {
        if ancestor == self.id.as_ref() {
            return Ok(true);
        }
        self.parents.iter().try_fold(false, |acc, parent| Ok(acc || self.ctx.read(parent)?.is_descendant(ancestor)?))
    }

    pub fn is_ancestor(&self, descendant: &ChangeIdRef) -> Result<bool> {
        Ok(self.ctx.read(descendant)?.is_descendant(&self.id)?)
    }

    pub fn parents(&self) -> Result<BTreeSet<ChangeId>> {
        // skip archived changes and target their parents directly.
        // skip dominators since their children will release into them.
        todo!()
    }

    /// No bases ==> change is a root (no parents)
    /// Multiple bases ==> base is the merge of the revisions
    pub fn bases(&self) -> Result<BTreeSet<Revision>> {
        let mut candidates = BTreeSet::new();

        // add merge bases for all parents
        for parent_id in self.parents()? {
            candidates.insert(self.ctx.merge_base(self.tip, self.ctx.read(&parent_id)?.tip)?);
        }

        self.ctx.maximal_revisions(&candidates)
    }
}

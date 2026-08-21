use std::collections::BTreeSet;

use elsa::FrozenBTreeMap;
use gix::Repository;

use crate::{
    change::{ChangeId, ChangeIdRef},
    revision::Revision,
    types::{Identity, Liveness},
};

// Effectively all operations should work on immutable references
pub struct TransactionContext {
    repo: Repository,
    read: FrozenBTreeMap<ChangeId, Box<Change>>,
}

impl TransactionContext {
    pub fn read(&self, change_id: &ChangeIdRef) -> &Change {
        match self.read.get(change_id) {
            Some(read) => &read,
            None => {
                // TODO(joel): read from log
                let parse = Box::new(Change::new());
                self.read.insert(change_id.to_owned(), parse)
            }
        }
    }
}

// TODO(joel): move
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Change {
    head: Revision,
    pub title: String,
    pub description: String,
    // TODO(joel): consider splitting back out?
    pub liveness: Liveness,
    pub owners: BTreeSet<Identity>,
    pub parents: BTreeSet<ChangeId>,
}

impl Change {
    pub fn new() -> Self { todo!() }
}

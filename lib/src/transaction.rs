use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
};

use elsa::FrozenBTreeMap;
use gix::{Repository, ThreadSafeRepository};

use crate::{
    cabaret2::Cabaret,
    change::{ChangeId, ChangeIdRef},
    error::Result,
    revision::Revision,
    types::{Identity, Liveness},
};

// Effectively all operations should work on immutable references
pub struct TransactionContext {
    repo: Repository,
    read: FrozenBTreeMap<ChangeId, Box<Change>>,
}

// TODO(joel): into_parts?
pub struct Transaction<const N: usize> {
    pub ctx: TransactionContext,
    pub data: [Change; N],
}

// TODO(joel): adopt more canonical names?
pub enum UpdateOrInsert<T> {
    Update(T),
    Insert(T),
}

impl Cabaret {
    pub(crate) fn transact<const N: usize, T, F>(
        &self,
        change_ids: &[UpdateOrInsert<&ChangeIdRef>; N],
        f: F,
    ) -> Result<T>
    where
        F: FnOnce(&TransactionContext, &mut [Change; N]) -> Result<T>,
    {
        // construct the transaction context
        // call f
        // attempt to apply any changes made
        todo!()
    }

    pub(crate) fn query<T, F>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&TransactionContext) -> Result<T>,
    {
        self.transact(&[], |ctx, []| f(ctx))
    }

    pub(crate) fn update<const N: usize, T, F>(&self, change_ids: &[&ChangeIdRef; N], f: F) -> Result<T>
    where
        F: FnOnce(&TransactionContext, &mut [Change; N]) -> Result<T>,
    {
        self.transact(&change_ids.map(|id| UpdateOrInsert::Update(id)), f)
    }

    pub(crate) fn insert<const N: usize, T, F>(&self, change_ids: &[&ChangeIdRef; N], f: F) -> Result<T>
    where
        F: FnOnce(&TransactionContext, &mut [Change; N]) -> Result<T>,
    {
        self.transact(&change_ids.map(|id| UpdateOrInsert::Insert(id)), f)
    }

    pub(crate) fn update1<T, F>(&self, change_id: &ChangeIdRef, f: F) -> Result<T>
    where
        F: FnOnce(&TransactionContext, &mut Change) -> Result<T>,
    {
        self.update(&[change_id], |ctx, [change]| f(ctx, change))
    }

    pub(crate) fn insert1<T, F>(&self, change_id: &ChangeIdRef, f: F) -> Result<T>
    where
        F: FnOnce(&TransactionContext, &mut Change) -> Result<T>,
    {
        self.insert(&[change_id], |ctx, [change]| f(ctx, change))
    }
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

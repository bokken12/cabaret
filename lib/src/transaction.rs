use crate::{cabaret::Cabaret, change::Change, change_id::ChangeIdRef, context::TransactionContext, error::Result};

// TODO(joel): into_parts?
// pub struct Transaction<const N: usize> {
//     pub ctx: TransactionContext,
//     pub data: [Change; N],
// }

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
        F: for<'ctx> FnOnce(&TransactionContext<'ctx>, &mut [Change<'ctx>; N]) -> Result<T>,
    {
        // construct the transaction context
        // call f
        // attempt to apply any changes made
        todo!()
    }

    pub(crate) fn query<T, F>(&self, f: F) -> Result<T>
    where
        F: for<'ctx> FnOnce(&TransactionContext<'ctx>) -> Result<T>,
    {
        self.transact(&[], |ctx, []| f(ctx))
    }

    pub(crate) fn update<const N: usize, T, F>(&self, change_ids: &[&ChangeIdRef; N], f: F) -> Result<T>
    where
        F: for<'ctx> FnOnce(&TransactionContext<'ctx>, &mut [Change<'ctx>; N]) -> Result<T>,
    {
        self.transact(&change_ids.map(|id| UpdateOrInsert::Update(id)), f)
    }

    pub(crate) fn insert<const N: usize, T, F>(&self, change_ids: &[&ChangeIdRef; N], f: F) -> Result<T>
    where
        F: for<'ctx> FnOnce(&TransactionContext<'ctx>, &mut [Change<'ctx>; N]) -> Result<T>,
    {
        self.transact(&change_ids.map(|id| UpdateOrInsert::Insert(id)), f)
    }

    pub(crate) fn update1<T, F>(&self, change_id: &ChangeIdRef, f: F) -> Result<T>
    where
        F: for<'ctx> FnOnce(&TransactionContext<'ctx>, &mut Change<'ctx>) -> Result<T>,
    {
        self.update(&[change_id], |ctx, [change]| f(ctx, change))
    }

    pub(crate) fn insert1<T, F>(&self, change_id: &ChangeIdRef, f: F) -> Result<T>
    where
        F: for<'ctx> FnOnce(&TransactionContext<'ctx>, &mut Change<'ctx>) -> Result<T>,
    {
        self.insert(&[change_id], |ctx, [change]| f(ctx, change))
    }
}

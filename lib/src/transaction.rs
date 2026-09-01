use crate::{cabaret::Cabaret, change::Change, change_id::ChangeIdRef, context::TransactionContext, error::Result};

// TODO(joel): adopt more canonical names?
pub enum UpdateOrInsert<T> {
    Update(T),
    Insert(T),
}

impl Cabaret {
    /// Run `f` against a fresh context and record what it changed.
    ///
    /// The context lives only for this call. `f` is quantified over the context's lifetime, so
    /// nothing it is handed (the context, a snapshot, its own mutable changes) can be returned:
    /// `T` cannot name `'ctx`. Inside, `ctx.read` is committed state and the array is in-flight
    /// state; a change's own methods see its in-flight fields and reach other changes through
    /// the context.
    pub(crate) fn transact<const N: usize, T, F>(
        &self,
        change_ids: &[UpdateOrInsert<&ChangeIdRef>; N],
        f: F,
    ) -> Result<T>
    where
        F: for<'ctx> FnOnce(&'ctx TransactionContext<'ctx>, &mut [Change<'ctx>; N]) -> Result<T>,
    {
        // TODO(joel): lock `change_ids` under .git/cabaret for the duration
        let ctx = TransactionContext::new(self.repo.to_thread_local());

        let mut changes = Vec::with_capacity(N);
        for change_id in change_ids {
            changes.push(match change_id {
                UpdateOrInsert::Update(change_id) => ctx.read(change_id)?.clone(),
                UpdateOrInsert::Insert(_change_id) => todo!("decide where an inserted change's tip comes from"),
            });
        }

        let mut changes: [Change<'_>; N] = changes.try_into().expect("one change per id");
        let out = f(&ctx, &mut changes)?;

        for change in changes {
            let actions = change.actions_since(ctx.read(change.id())?);
            if !actions.is_empty() {
                todo!("append {actions:?} to the log and commit it");
            }
        }
        Ok(out)
    }

    pub(crate) fn query<T, F>(&self, f: F) -> Result<T>
    where
        F: for<'ctx> FnOnce(&'ctx TransactionContext<'ctx>) -> Result<T>,
    {
        self.transact(&[], |ctx, []| f(ctx))
    }

    pub(crate) fn update<const N: usize, T, F>(&self, change_ids: &[&ChangeIdRef; N], f: F) -> Result<T>
    where
        F: for<'ctx> FnOnce(&'ctx TransactionContext<'ctx>, &mut [Change<'ctx>; N]) -> Result<T>,
    {
        self.transact(&change_ids.map(UpdateOrInsert::Update), f)
    }

    pub(crate) fn insert<const N: usize, T, F>(&self, change_ids: &[&ChangeIdRef; N], f: F) -> Result<T>
    where
        F: for<'ctx> FnOnce(&'ctx TransactionContext<'ctx>, &mut [Change<'ctx>; N]) -> Result<T>,
    {
        self.transact(&change_ids.map(UpdateOrInsert::Insert), f)
    }

    pub(crate) fn update1<T, F>(&self, change_id: &ChangeIdRef, f: F) -> Result<T>
    where
        F: for<'ctx> FnOnce(&'ctx TransactionContext<'ctx>, &mut Change<'ctx>) -> Result<T>,
    {
        self.update(&[change_id], |ctx, [change]| f(ctx, change))
    }

    pub(crate) fn insert1<T, F>(&self, change_id: &ChangeIdRef, f: F) -> Result<T>
    where
        F: for<'ctx> FnOnce(&'ctx TransactionContext<'ctx>, &mut Change<'ctx>) -> Result<T>,
    {
        self.insert(&[change_id], |ctx, [change]| f(ctx, change))
    }
}

use gix::refs::{
    Target,
    transaction::{Change as RefChange, LogChange, PreviousValue, RefEdit, RefLog},
};

use crate::{
    cabaret::Cabaret,
    change::Change,
    context::TransactionContext,
    error::Result,
    types::{ChangeIdRef, Revision},
};

pub enum UpdateOrInsert<'a> {
    Update { id: &'a ChangeIdRef },
    Insert { id: &'a ChangeIdRef, tip: Revision },
}

impl UpdateOrInsert<'_> {
    /// The change's state before the transaction: as committed, or empty at `tip` for an insert.
    fn before<'ctx>(&self, ctx: &'ctx TransactionContext<'ctx>) -> Result<Change<'ctx>> {
        Ok(match self {
            UpdateOrInsert::Update { id } => ctx.read(id)?.clone(),
            UpdateOrInsert::Insert { id, tip } => Change::new(ctx, (*id).to_owned(), *tip),
        })
    }
}

impl Cabaret {
    /// Run `f` against a fresh context and record what it changed.
    ///
    /// The context lives only for this call. `f` is quantified over the context's lifetime, so
    /// nothing it is handed (the context, a snapshot, its own mutable changes) can be returned:
    /// `T` cannot name `'ctx`. Inside, `ctx.read` is committed state and the array is in-flight
    /// state; a change's own methods see its in-flight fields and reach other changes through
    /// the context.
    pub(crate) fn transact<const N: usize, T, F>(&self, change_ids: &[UpdateOrInsert<'_>; N], f: F) -> Result<T>
    where
        F: for<'ctx> FnOnce(&'ctx TransactionContext<'ctx>, &mut [Change<'ctx>; N]) -> Result<T>,
    {
        // TODO(joel): retry on ref contention instead of surfacing it
        let ctx = TransactionContext::new(self.repo.to_thread_local());

        let mut changes = Vec::with_capacity(N);
        for change_id in change_ids {
            changes.push(change_id.before(&ctx)?);
        }
        let mut changes: [Change<'_>; N] = changes.try_into().expect("one change per id");
        let out = f(&ctx, &mut changes)?;

        // Every change's log and branch land in one ref transaction, so a partial write cannot be observed.
        let mut edits = Vec::new();
        for (change_id, change) in change_ids.iter().zip(&changes) {
            let actions = change.actions_since(&change_id.before(&ctx)?);
            match change_id {
                UpdateOrInsert::Insert { id, tip } => {
                    edits.push(RefEdit {
                        change: RefChange::Update {
                            log: LogChange {
                                mode: RefLog::AndReference,
                                force_create_reflog: false,
                                message: "cabaret: create".into(),
                            },
                            expected: PreviousValue::MustNotExist,
                            new: Target::Object(tip.0),
                        },
                        name: id.branch_ref(),
                        deref: false,
                    });
                    edits.push(change.append(actions)?);
                }
                UpdateOrInsert::Update { .. } if actions.is_empty() => {}
                UpdateOrInsert::Update { .. } => edits.push(change.append(actions)?),
            }
        }
        if !edits.is_empty() {
            ctx.repo.edit_references(edits)?;
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
        self.transact(&change_ids.map(|id| UpdateOrInsert::Update { id }), f)
    }

    pub(crate) fn update1<T, F>(&self, change_id: &ChangeIdRef, f: F) -> Result<T>
    where
        F: for<'ctx> FnOnce(&'ctx TransactionContext<'ctx>, &mut Change<'ctx>) -> Result<T>,
    {
        self.update(&[change_id], |ctx, [change]| f(ctx, change))
    }

    pub(crate) fn insert1<T, F>(&self, change_id: &ChangeIdRef, tip: Revision, f: F) -> Result<T>
    where
        F: for<'ctx> FnOnce(&'ctx TransactionContext<'ctx>, &mut Change<'ctx>) -> Result<T>,
    {
        self.transact(&[UpdateOrInsert::Insert { id: change_id, tip }], |ctx, [change]| f(ctx, change))
    }
}

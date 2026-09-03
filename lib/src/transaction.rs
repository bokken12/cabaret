use std::{collections::BTreeSet, time::Duration};

use gix::{
    lock::{Marker, acquire::Fail},
    refs::{
        Target,
        transaction::{Change as RefChange, LogChange, PreviousValue, RefEdit, RefLog},
    },
};

use crate::{
    branch::Branch,
    cabaret::Cabaret,
    context::TransactionContext,
    error::Result,
    metadata::Metadata,
    types::{ChangeIdRef, Revision},
};

/// A branch in a transaction's write set. A branch that is only read still goes here: there is
/// no read mode, and declaring it keeps it from moving underneath the transaction.
pub enum BranchOp<'a> {
    Update(&'a ChangeIdRef),
    Insert { id: &'a ChangeIdRef, tip: Revision },
}

impl<'a> BranchOp<'a> {
    fn id(&self) -> &'a ChangeIdRef {
        match self {
            BranchOp::Update(id) | BranchOp::Insert { id, .. } => id,
        }
    }

    /// The branch before the transaction: as committed, or at `tip` for an insert.
    fn before<'ctx>(&self, ctx: &'ctx TransactionContext<'ctx>) -> Result<Branch<'ctx>> {
        Ok(match self {
            BranchOp::Update(id) => ctx.branch(id)?.clone(),
            BranchOp::Insert { id, tip } => Branch::new(ctx, (*id).to_owned(), *tip),
        })
    }
}

/// How long a transaction waits for another's locks before giving up; a lock older than this
/// was most likely left behind by a killed process.
const LOCK_TIMEOUT: Duration = Duration::from_mins(1);

/// The independently lockable parts of a change; each has its own directory of lock files.
#[derive(Clone, Copy, Debug)]
enum Resource {
    Metadata,
    Branch,
}

impl Resource {
    fn dir_name(self) -> &'static str {
        match self {
            Resource::Metadata => "metadata",
            Resource::Branch => "branch",
        }
    }
}

impl Cabaret {
    /// Take the `resource` lock of each change in `ids`, in a fixed order to avoid deadlock.
    fn lock<'a>(&self, resource: Resource, ids: impl ExactSizeIterator<Item = &'a ChangeIdRef>) -> Result<Vec<Marker>> {
        let count = ids.len();
        let ids: BTreeSet<&ChangeIdRef> = ids.collect();
        if ids.len() != count {
            Err(format!("cannot lock the same {} twice", resource.dir_name()))?;
        }
        let dir = self.locks.join(resource.dir_name());
        let mut locks = Vec::with_capacity(ids.len());
        for id in ids {
            let mode = Fail::AfterDurationWithBackoff(LOCK_TIMEOUT);
            locks.push(Marker::acquire_to_hold_resource(dir.join(id.to_string()), mode, Some(dir.clone()))?);
        }
        Ok(locks)
    }

    /// Run `f` against a fresh context and record what it changed.
    ///
    /// The context lives only for this call. `f` is quantified over the context's lifetime, so
    /// nothing it is handed (the context, its own mutable metadata and branches) can be returned:
    /// `T` cannot name `'ctx`. Inside, `ctx.metadata` and `ctx.branch` are committed state and
    /// the arrays are in-flight state; an in-flight object's own methods see its fields and reach
    /// other changes through the context.
    pub(crate) fn transact<const M: usize, const N: usize, T, F>(
        &self,
        metadata_ids: &[&ChangeIdRef; M],
        branch_ops: &[BranchOp<'_>; N],
        f: F,
    ) -> Result<T>
    where
        F: for<'ctx> FnOnce(
            &'ctx TransactionContext<'ctx>,
            &mut [Metadata<'ctx>; M],
            &mut [Branch<'ctx>; N],
        ) -> Result<T>,
    {
        // metadata before branches, always, so two transactions cannot wait on each other
        let mut locks = self.lock(Resource::Metadata, metadata_ids.iter().copied())?;
        locks.extend(self.lock(Resource::Branch, branch_ops.iter().map(BranchOp::id))?);
        // TODO(joel): retry on ref contention instead of surfacing it
        let ctx = TransactionContext::new(self.repo.to_thread_local(), locks);

        // Metadata needs no insert: a change without a log has empty metadata, and its first
        // append creates the log.
        let mut metadata = Vec::with_capacity(M);
        for id in metadata_ids {
            metadata.push(ctx.metadata(id)?.clone());
        }
        let mut metadata: [Metadata<'_>; M] = metadata.try_into().expect("one metadata per id");
        let mut branches = Vec::with_capacity(N);
        for op in branch_ops {
            branches.push(op.before(&ctx)?);
        }
        let mut branches: [Branch<'_>; N] = branches.try_into().expect("one branch per op");
        let out = f(&ctx, &mut metadata, &mut branches)?;

        // Every log and branch lands in one ref transaction, so a partial write cannot be observed.
        let mut edits = Vec::new();
        for (id, metadata) in metadata_ids.iter().zip(&metadata) {
            let actions = metadata.actions_since(ctx.metadata(id)?);
            if !actions.is_empty() {
                edits.push(metadata.append(actions)?);
            }
        }
        let mut moved = Vec::new();
        for (op, branch) in branch_ops.iter().zip(&branches) {
            let before = op.before(&ctx)?;
            let (expected, message) = match op {
                BranchOp::Insert { .. } => (PreviousValue::MustNotExist, "cabaret: create"),
                BranchOp::Update(_) if branch.tip != before.tip => {
                    moved.push((branch, before.tip));
                    (PreviousValue::MustExistAndMatch(Target::Object(before.tip.0)), "cabaret: update")
                }
                BranchOp::Update(_) => continue,
            };
            edits.push(RefEdit {
                change: RefChange::Update {
                    log: LogChange { mode: RefLog::AndReference, force_create_reflog: false, message: message.into() },
                    expected,
                    new: Target::Object(branch.tip.0),
                },
                name: branch.id().branch_ref(),
                deref: false,
            });
        }
        if !edits.is_empty() {
            ctx.repo.edit_references(edits)?;
        }
        // Workspaces follow once the branches have moved: a failed transaction leaves them behind
        // rather than ahead of it.
        for (branch, from) in moved {
            if let Some(workspace) = branch.workspace()? {
                ctx.fast_forward(&workspace, from, branch.tip)?;
            }
        }
        Ok(out)
    }

    pub(crate) fn query<T, F>(&self, f: F) -> Result<T>
    where
        F: for<'ctx> FnOnce(&'ctx TransactionContext<'ctx>) -> Result<T>,
    {
        self.transact(&[], &[], |ctx, [], []| f(ctx))
    }

    pub(crate) fn update_metadata<T, F>(&self, id: &ChangeIdRef, f: F) -> Result<T>
    where
        F: for<'ctx> FnOnce(&'ctx TransactionContext<'ctx>, &mut Metadata<'ctx>) -> Result<T>,
    {
        self.transact(&[id], &[], |ctx, [metadata], []| f(ctx, metadata))
    }

    pub(crate) fn update_branch<T, F>(&self, id: &ChangeIdRef, f: F) -> Result<T>
    where
        F: for<'ctx> FnOnce(&'ctx TransactionContext<'ctx>, &mut Branch<'ctx>) -> Result<T>,
    {
        self.transact(&[], &[BranchOp::Update(id)], |ctx, [], [branch]| f(ctx, branch))
    }
}

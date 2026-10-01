use std::{
    collections::BTreeSet,
    fmt,
    path::{Path, PathBuf},
    time::Duration,
};

use cabaret_types::{ChangeIdRef, Result, RevisionId, WorkspaceId, WorkspaceIdRef};
use gix::{
    ThreadSafeRepository,
    lock::{Marker, acquire::Fail},
    refs::{
        Target,
        transaction::{Change as RefChange, LogChange, PreviousValue, RefEdit, RefLog},
    },
};

use crate::{
    branch::Branch,
    context::TransactionContext,
    metadata::Metadata,
    workspace::{Head, Workspace},
};

/// A branch in a transaction's write set. A branch that is only read still goes here: there is
/// no read mode, and declaring it keeps it from moving underneath the transaction.
pub enum BranchOp<'a> {
    // TODO(joel): convert tuple-struct to named?
    Update(&'a ChangeIdRef),
    Insert { id: &'a ChangeIdRef, tip: RevisionId },
}

impl<'a> BranchOp<'a> {
    fn id(&self) -> &'a ChangeIdRef {
        match self {
            BranchOp::Update(id) | BranchOp::Insert { id, .. } => id,
        }
    }

    /// The branch before the transaction: as committed, or at `tip` for an insert. An insert
    /// refuses an id whose branch exists: gix's `MustNotExist` lets a ref be rewritten to the
    /// value it already has, which would pass creating a change twice off as a success.
    fn before<'ctx>(&self, ctx: &'ctx TransactionContext<'ctx>) -> Result<Branch<'ctx>> {
        Ok(match self {
            BranchOp::Update(id) => ctx.branch(id)?.clone(),
            BranchOp::Insert { id, tip } => {
                if ctx.repo.try_find_reference(&id.branch_ref())?.is_some() {
                    Err(format!("{id} already exists"))?;
                }
                Branch::new(ctx, (*id).to_owned(), *tip)
            }
        })
    }
}
pub enum WorkspaceOp<'a> {
    Update { id: WorkspaceIdRef<'a> },
    Insert { path: &'a Path, head: Head },
    Delete { id: WorkspaceIdRef<'a> },
}

impl WorkspaceOp<'_> {
    fn id(&self) -> Result<WorkspaceId> {
        match self {
            WorkspaceOp::Update { id } | WorkspaceOp::Delete { id } => Ok(id.into_owned()),
            WorkspaceOp::Insert { path, .. } => WorkspaceId::linked_at(path),
        }
    }

    /// The workspace before the transaction: as committed, or not yet made for an insert.
    fn before<'ctx>(&self, ctx: &'ctx TransactionContext<'ctx>) -> Result<Workspace<'ctx>> {
        Ok(match self {
            WorkspaceOp::Update { id } | WorkspaceOp::Delete { id } => ctx.workspace(*id)?.clone(),
            WorkspaceOp::Insert { path, head } => Workspace::new(ctx, path, head.clone())?,
        })
    }
}

/// The revision `workspace`'s head is at as the transaction leaves it. Its change must be
/// declared, or it could move underneath the checkout, and must not be checked out elsewhere,
/// which git refuses too.
fn checkout_tip(workspace: &Workspace<'_>, branches: &[Branch<'_>]) -> Result<RevisionId> {
    match &workspace.head {
        Head::Detached(revision) => Ok(*revision),
        Head::Change(id) => {
            let branch = branches
                .iter()
                .find(|branch| *branch.id() == **id)
                .ok_or_else(|| format!("{id} must be declared to be checked out"))?;
            if let Some(holder) = branch.workspace()?
                && holder != workspace.id()
            {
                Err(format!("{id} is already checked out in workspace {holder}"))?;
            }
            Ok(branch.tip)
        }
    }
}

/// The revision `head` was at as committed.
fn committed_tip<'ctx>(ctx: &'ctx TransactionContext<'ctx>, head: &Head) -> Result<RevisionId> {
    match head {
        Head::Detached(revision) => Ok(*revision),
        Head::Change(id) => Ok(ctx.branch(id)?.tip),
    }
}

/// How long a transaction waits for another's locks before giving up; a lock older than this
/// was most likely left behind by a killed process.
const LOCK_TIMEOUT: Duration = Duration::from_secs(5);

/// The independently lockable resources of a repository; each has its own directory of lock
/// files, named by the change (metadata, branch) or workspace they belong to.
#[derive(Clone, Copy, Debug)]
enum Resource {
    Metadata,
    Branch,
    Workspace,
}

impl Resource {
    fn dir_name(self) -> &'static str {
        match self {
            Resource::Metadata => "metadata",
            Resource::Branch => "branch",
            Resource::Workspace => "workspace",
        }
    }
}

/// A repository together with the directory its transactions lock resources in.
pub struct Store {
    repo: ThreadSafeRepository,
    /// Under the common dir, so every workspace of the repository shares the same locks.
    pub locks: PathBuf,
}

impl From<ThreadSafeRepository> for Store {
    fn from(repo: ThreadSafeRepository) -> Self {
        let locks = repo.to_thread_local().common_dir().join("cabaret").join("locks");
        Self { repo, locks }
    }
}

impl Store {
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> { Ok(ThreadSafeRepository::discover(dir)?.into()) }

    /// The repository reopened, so config written since the store opened, here or by another
    /// process, is seen.
    pub fn repo(&self) -> Result<gix::Repository> {
        let mut repo = self.repo.to_thread_local();
        repo.reload()?;
        Ok(repo)
    }

    /// Take the `resource` lock of each of `ids`, in a fixed order to avoid deadlock.
    fn lock<Id: Ord + fmt::Display>(
        &self,
        resource: Resource,
        ids: impl ExactSizeIterator<Item = Id>,
    ) -> Result<Vec<Marker>> {
        let count = ids.len();
        let ids: BTreeSet<Id> = ids.collect();
        if ids.len() != count {
            Err(format!("cannot lock the same {} twice", resource.dir_name()))?;
        }
        let dir = self.locks.join(resource.dir_name());
        let mut locks = Vec::with_capacity(ids.len());
        for id in ids {
            let mode = Fail::AfterDurationWithBackoff(LOCK_TIMEOUT);
            // TODO-someday(joel): sanitize string representation
            locks.push(Marker::acquire_to_hold_resource(dir.join(id.to_string()), mode, Some(dir.clone()))?);
        }
        Ok(locks)
    }

    // TODO-someday(joel): variable-sized transactions?
    // TODO(joel): transactions do not (yet) modify changes
    /// Run `f` against a fresh context and record what it changed; if `f` fails, as when
    /// refused, nothing is recorded.
    ///
    /// The context lives only for this call. `f` is quantified over the context's lifetime, so
    /// nothing it is handed (the context, its own mutable metadata and branches) can be returned:
    /// `T` cannot name `'ctx`. Inside, `ctx.metadata` and `ctx.branch` are committed state and
    /// the arrays are in-flight state; an in-flight object's own methods see its fields and reach
    /// other changes through the context.
    pub fn transact<const L: usize, const M: usize, const N: usize, T, F>(
        &self,
        metadata_ids: &[&ChangeIdRef; L],
        branch_ops: &[BranchOp<'_>; M],
        workspace_ops: &[WorkspaceOp<'_>; N],
        f: F,
    ) -> Result<T>
    where
        F: for<'ctx> FnOnce(
            &'ctx TransactionContext<'ctx>,
            &mut [Metadata<'ctx>; L],
            &mut [Branch<'ctx>; M],
            &mut [Workspace<'ctx>; N],
        ) -> Result<T>,
    {
        // metadata, then branches, then workspaces, always, so two transactions cannot wait on
        // each other
        let mut locks = self.lock(Resource::Metadata, metadata_ids.iter().copied())?;
        locks.extend(self.lock(Resource::Branch, branch_ops.iter().map(BranchOp::id))?);
        let workspace_ids = workspace_ops.iter().map(WorkspaceOp::id).collect::<Result<Vec<_>>>()?;
        locks.extend(self.lock(Resource::Workspace, workspace_ids.iter())?);
        // TODO(joel): retry on ref contention instead of surfacing it
        let ctx = TransactionContext::new(self.repo()?, locks);

        // Metadata needs no insert: a change without a log has empty metadata, and its first
        // append creates the log.
        let mut metadata = Vec::with_capacity(L);
        for id in metadata_ids {
            metadata.push(ctx.metadata(id)?.clone());
        }
        let mut metadata: [Metadata<'_>; L] = metadata.try_into().expect("one metadata per id");
        let mut branches = Vec::with_capacity(M);
        for op in branch_ops {
            branches.push(op.before(&ctx)?);
        }
        let mut branches: [Branch<'_>; M] = branches.try_into().expect("one branch per op");

        let mut workspaces = Vec::with_capacity(N);
        for op in workspace_ops {
            workspaces.push(op.before(&ctx)?);
        }
        let mut workspaces: [Workspace<'_>; N] = workspaces.try_into().expect("one workspace per op");
        // A fast-forward writes a workspace's files under only the lock of the branch it holds,
        // so everything else writing there must hold that lock too.
        for workspace in &workspaces {
            if let Some(held) = workspace.change()
                && !branch_ops.iter().any(|op| *op.id() == **held)
            {
                Err(format!("{held} must be declared to touch workspace {}", workspace.id()))?;
            }
        }

        let out = f(&ctx, &mut metadata, &mut branches, &mut workspaces)?;

        // Every metadata and branch lands in one ref transaction, so a partial write cannot be observed.
        let mut edits = Vec::new();
        for (id, metadata) in metadata_ids.iter().zip(&metadata) {
            edits.extend(metadata.write_since(ctx.metadata(id)?)?);
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
        for (branch, _) in &moved {
            if let Some(workspace) = branch.workspace()? {
                Workspace::load(&ctx, workspace.to_ref())?.check_settled()?;
            }
        }
        if !edits.is_empty() {
            ctx.repo.edit_references(edits)?;
        }
        // Workspaces are written once the branches have moved: a failed transaction leaves them
        // behind rather than ahead of it.
        for (op, workspace) in workspace_ops.iter().zip(&mut workspaces) {
            match op {
                WorkspaceOp::Insert { .. } => workspace.create(checkout_tip(workspace, &branches)?)?,
                WorkspaceOp::Update { id } => {
                    let before = ctx.workspace(*id)?;
                    if before.head != workspace.head {
                        workspace.switch(committed_tip(&ctx, &before.head)?, checkout_tip(workspace, &branches)?)?;
                    }
                }
                WorkspaceOp::Delete { .. } => workspace.delete()?,
            }
        }
        for (branch, from) in moved {
            if let Some(workspace) = branch.workspace()? {
                Workspace::load(&ctx, workspace.to_ref())?.fast_forward(from, branch)?;
            }
        }
        Ok(out)
    }

    pub fn query<T, F>(&self, f: F) -> Result<T>
    where
        F: for<'ctx> FnOnce(&'ctx TransactionContext<'ctx>) -> Result<T>,
    {
        self.transact(&[], &[], &[], |ctx, [], [], []| f(ctx))
    }

    /// Bring `id`'s log up to date with origin's; see [`Metadata::merge_origin`]. A merge is a
    /// transaction of its own: it writes the log commits it merges rather than actions taken now,
    /// so no in-flight metadata can express it.
    pub fn merge_origin_log(&self, id: &ChangeIdRef) -> Result<()> {
        let ctx = TransactionContext::new(self.repo()?, self.lock(Resource::Metadata, [id].into_iter())?);
        if let Some(edit) = ctx.metadata(id)?.merge_origin()? {
            ctx.repo.edit_reference(edit)?;
        }
        Ok(())
    }

    pub fn update_metadata<T, F>(&self, id: &ChangeIdRef, f: F) -> Result<T>
    where
        F: for<'ctx> FnOnce(&'ctx TransactionContext<'ctx>, &mut Metadata<'ctx>) -> Result<T>,
    {
        self.transact(&[id], &[], &[], |ctx, [metadata], [], []| f(ctx, metadata))
    }
}

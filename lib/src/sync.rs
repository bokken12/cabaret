use gix::refs::FullName;

use crate::{cabaret::Cabaret, error::Result, types::ChangeId};

/// What syncing a branch with its remote counterpart did, or why it did nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncOutcome {
    /// The remote has no counterpart for this branch.
    Unpublished,
    UpToDate,
    /// The remote was strictly ahead; the branch fast-forwarded to it.
    FastForwarded,
    /// The remote is ahead, but the workspace holding the branch has uncommitted changes.
    Dirty,
    /// The branch is strictly ahead of the remote; push to sync.
    Ahead,
    /// Both the branch and the remote have new commits; reconcile manually.
    Diverged,
}

impl Cabaret {
    pub fn fetch(&self) -> Result<()> {
        let remote = self.repo.find_default_remote(gix::remote::Direction::Fetch).ok_or("no remote configured")??;
        let logs = format!("+refs/cabaret/*:refs/cabaret/remotes/{}/*", self.remote_name()?);
        remote
            .with_refspecs([logs.as_str()], gix::remote::Direction::Fetch)?
            .connect(gix::remote::Direction::Fetch)?
            .prepare_fetch(gix::progress::Discard, gix::remote::ref_map::Options::default())?
            .receive(gix::progress::Discard, &gix::interrupt::IS_INTERRUPTED)?;
        Ok(())
    }

    /// Bring `change`'s branch up to date with its remote counterpart when that is a clean
    /// fast-forward, refreshing the workspace that has it checked out, if any.
    pub fn sync_branch(&self, _change: &ChangeId) -> Result<SyncOutcome> { todo!() }

    /// Push `changes`' branches to the remote, which must be able to fast-forward to them.
    pub fn push(&self, changes: &[ChangeId]) -> Result<()> {
        let remote = self.remote_name()?;
        let mut command = self.git_when_gix_unimplemented();
        command.arg("push").arg("--quiet").arg(remote.to_string());
        for change in changes {
            command.arg(format!("{0}:{0}", change.branch_ref().as_bstr()));
        }
        if !command.status()?.success() {
            return Err("git push failed".into());
        }
        Ok(())
    }

    fn remote_name(&self) -> Result<gix::bstr::BString> {
        self.repo.remote_default_name(gix::remote::Direction::Fetch).ok_or_else(|| "no remote configured".into())
    }

    fn _remote_tracking_ref(&self, change: &ChangeId) -> Result<FullName> {
        Ok(FullName::try_from(format!("refs/remotes/{}/{change}", self.remote_name()?))?)
    }
}

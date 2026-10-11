use std::{
    collections::{BTreeMap, BTreeSet},
    process::Command,
};

use cabaret_transaction::BranchOp;
use cabaret_types::{ChangeId, ChangeIdRef, Result, RevisionId};
use gix::{bstr::ByteSlice, protocol::handshake::Ref, remote::Direction};

use crate::cabaret::Cabaret;

impl Cabaret {
    pub fn has_origin(&self) -> bool { self.store.repo.to_thread_local().remote_names().contains(b"origin".as_bstr()) }

    /// Exchange logs and branches with origin, so that both end up having seen every write either
    /// has: fetch origin's, merge each of its logs into the local one, bring each synced branch
    /// level with origin's, then push every local log and each synced branch origin is behind on.
    /// The synced branches are origin's default branch and those of unarchived changes with a
    /// log; any other is fetched only as `refs/remotes/origin/*`. Returns the synced branches left
    /// apart from origin's, each with why.
    pub fn fetch(&self) -> Result<BTreeMap<ChangeId, String>> {
        let repo = self.store.repo.to_thread_local();
        let mut remote = repo.find_remote("origin")?;
        let logs = format!("{}*", ChangeIdRef::LOG_REF_PREFIX);
        let origin_logs = format!("+{logs}:{}*", ChangeIdRef::ORIGIN_LOG_REF_PREFIX);
        remote.replace_refspecs(["+refs/heads/*:refs/remotes/origin/*", origin_logs.as_str()], Direction::Fetch)?;
        // Only asked for, so that origin advertises which branch it holds as HEAD.
        let head = gix::refspec::parse("HEAD".into(), gix::refspec::parse::Operation::Fetch)?.to_owned();
        let options = gix::remote::ref_map::Options { extra_refspecs: vec![head], ..Default::default() };
        let fetched = remote
            .connect(Direction::Fetch)?
            .prepare_fetch(gix::progress::Discard, options)?
            .receive(gix::progress::Discard, &gix::interrupt::IS_INTERRUPTED)?;

        for reference in repo.references()?.prefixed(ChangeIdRef::ORIGIN_LOG_REF_PREFIX)? {
            let name = reference?.name().as_bstr().to_str()?.to_owned();
            let change_id: ChangeId =
                name.strip_prefix(ChangeIdRef::ORIGIN_LOG_REF_PREFIX).expect("listed by this prefix").parse()?;
            self.store.merge_origin_log(&change_id)?;
        }

        let mut synced = BTreeSet::new();
        for reference in &fetched.ref_map.remote_refs {
            if let Ref::Symbolic { full_ref_name, target, .. } | Ref::Unborn { full_ref_name, target } = reference
                && full_ref_name == "HEAD"
                && let Some(branch) = target.strip_prefix(b"refs/heads/")
            {
                synced.insert(branch.to_str()?.parse::<ChangeId>()?);
            }
        }
        self.store.query(|ctx| {
            for reference in ctx.repo.references()?.prefixed(ChangeIdRef::LOG_REF_PREFIX)? {
                let name = reference?.name().as_bstr().to_str()?.to_owned();
                let change_id: ChangeId =
                    name.strip_prefix(ChangeIdRef::LOG_REF_PREFIX).expect("listed by this prefix").parse()?;
                if !ctx.metadata(&change_id)?.archived {
                    synced.insert(change_id);
                }
            }
            Ok(())
        })?;

        let mut refspecs = vec![format!("{logs}:{logs}")];
        let mut apart = BTreeMap::new();
        for change_id in synced {
            match self.sync_branch(&change_id) {
                Ok(true) => refspecs.push(format!("{0}:{0}", change_id.branch_ref())),
                Ok(false) => {}
                Err(error) => {
                    apart.insert(change_id, format!("{error:?}"));
                }
            }
        }

        // gix cannot push yet.
        let pushed = Command::new("git")
            .arg("--git-dir")
            .arg(repo.common_dir())
            .args(["push", "--quiet", "origin"])
            .args(&refspecs)
            .output()?;
        if !pushed.status.success() {
            Err(format!("pushing to origin failed: {}", String::from_utf8_lossy(&pushed.stderr).trim_end()))?;
        }
        Ok(apart)
    }

    /// Bring `change_id`'s branch level with origin's as last fetched, by creating it or
    /// fast-forwarding it, returning whether origin's is behind instead and so wants pushing. A
    /// branch only ever fast-forwards, so it fails, moving nothing, if the two have diverged or
    /// if its workspace's local changes would conflict with origin's.
    fn sync_branch(&self, change_id: &ChangeIdRef) -> Result<bool> {
        let repo = self.store.repo.to_thread_local();
        let local = repo.try_find_reference(&change_id.branch_ref())?.is_some();
        let Some(origin) = repo.try_find_reference(&change_id.origin_branch_ref())? else { return Ok(local) };
        let origin = RevisionId(origin.into_fully_peeled_id()?.detach());
        if !local {
            // TODO-someday(joel): check out the files in a workspace whose unborn HEAD names this branch
            let insert = BranchOp::Insert { id: change_id, tip: origin };
            self.store.transact(&[], &[insert], &[], |_ctx, [], [_branch], []| Ok(()))?;
            return Ok(false);
        }
        self.store.transact(&[], &[BranchOp::Update(change_id)], &[], |ctx, [], [branch], []| {
            if ctx.is_predecessor(origin, branch.tip)? {
                return Ok(branch.tip != origin);
            }
            if !ctx.is_predecessor(branch.tip, origin)? {
                Err("diverged from origin")?;
            }
            let from = branch.tip;
            branch.tip = origin;
            if let Some(workspace) = branch.workspace()?
                && ctx.workspace(workspace.to_ref())?.fast_forward_conflicts(from, branch)?
            {
                Err(format!("local changes in workspace {workspace} conflict with origin's"))?;
            }
            Ok(false)
        })
    }
}

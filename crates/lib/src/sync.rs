use std::{
    collections::{BTreeMap, BTreeSet},
    process::Command,
};

use cabaret_config::{ForgeCursor, Scope};
use cabaret_forge::github::{GitHub, PullRequest};
use cabaret_transaction::BranchOp;
use cabaret_types::{ChangeId, ChangeIdRef, Result, Reviewing, RevisionId, log::ForgeEvent};
use gix::{bstr::ByteSlice, protocol::handshake::Ref, remote::Direction};

use crate::cabaret::Cabaret;

/// Something a change says that its forge change does not yet, for exporting to make so.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForgeExport {
    /// The change is up for review and has no forge change.
    Open { change: ChangeId, title: String, parent: ChangeId },
    /// The forge change's title or parent, whichever is given, is not the change's.
    Edit { change: ChangeId, title: Option<String>, parent: Option<ChangeId> },
}

impl Cabaret {
    pub fn has_origin(&self) -> bool { self.store.repo.to_thread_local().remote_names().contains(b"origin".as_bstr()) }

    /// Exchange logs and branches with origin, so that both end up having seen every write either
    /// has: fetch origin's, merge each of its logs into the local one, import what its forge
    /// changes have seen happen (see [`Self::import_forge`]), bring each synced branch level with
    /// origin's, then push every local log and each synced branch origin is behind on.
    /// The synced branches are origin's default branch and those of unarchived changes with a
    /// log; any other is fetched only as `refs/remotes/origin/*`. Returns the synced branches left
    /// apart from origin's, each with why.
    pub fn sync(&self) -> Result<BTreeMap<ChangeId, String>> {
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

        for change_id in changes_under(&repo, ChangeIdRef::ORIGIN_LOG_REF_PREFIX)? {
            self.store.merge_origin_log(&change_id)?;
        }
        self.import_forge()?;

        let mut synced = BTreeSet::new();
        for reference in &fetched.ref_map.remote_refs {
            if let Ref::Symbolic { full_ref_name, target, .. } | Ref::Unborn { full_ref_name, target } = reference
                && full_ref_name == "HEAD"
                && let Some(branch) = target.strip_prefix(b"refs/heads/")
            {
                synced.insert(branch.to_str()?.parse::<ChangeId>()?);
            }
        }
        self.store.query(|txn| {
            for change_id in changes_under(&txn.repo, ChangeIdRef::LOG_REF_PREFIX)? {
                if !txn.metadata(&change_id)?.archived {
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

    // TODO-someday(joel): a repository setting saying a dedicated bridge imports, so that other
    // devices stop asking the forge.
    /// Import the history of each of origin's pull requests that has changed since the last
    /// import, or of each open one the first time. Does nothing when origin is not on a forge
    /// Cabaret knows, or nothing here authenticates to it: whoever can reach the forge imports
    /// for everyone, through the logs.
    fn import_forge(&self) -> Result<()> {
        let mut repo = self.store.repo.to_thread_local();
        // Config is read as of opening, and an earlier import may have moved the cursor since.
        repo.reload()?;
        let Some(url) = repo.find_remote("origin")?.url(Direction::Fetch).map(|url| url.to_bstring().to_string())
        else {
            return Ok(());
        };
        let Some((owner, name)) = GitHub::repository(&url) else { return Ok(()) };
        let Some(github) = GitHub::connect(owner, name)? else { return Ok(()) };
        let cursor = cabaret_config::get::<ForgeCursor>(&repo)?;
        let updated = github.updated(cursor.map(|cursor| cursor.0))?;
        for pull_request in &updated {
            // Asked first of what listing says, which spares fetching a history only to skip it.
            let change_id: ChangeId = pull_request.head_ref_name.parse()?;
            if self.imports(&change_id, pull_request.is_cross_repository, pull_request.open)? {
                self.import_pull_request(&github.pull_request(pull_request.number)?, pull_request.open)?;
            }
        }
        // At or after rather than after: a pull request can change again within the second.
        if let Some(latest) = updated.iter().map(|pull_request| pull_request.at).max() {
            cabaret_config::set(&repo, Scope::Local, &ForgeCursor(latest))?;
        }
        Ok(())
    }

    /// Whether a pull request with head branch `change_id` is imported. One from a fork is not,
    /// and nor is one no longer `open` unless its change already has a log: a pull request closed
    /// before anything here knew of it is not worth a change of its own.
    fn imports(&self, change_id: &ChangeIdRef, is_cross_repository: bool, open: bool) -> Result<bool> {
        // TODO-someday(joel): a fork's head branch is not on origin, so has no change to be the log of.
        if is_cross_repository {
            return Ok(false);
        }
        let known = self.store.repo.to_thread_local().try_find_reference(&change_id.log_ref())?.is_some();
        Ok(open || known)
    }

    /// Record `pull_request`'s history in the log of the change named for its head branch, if it
    /// is imported; see [`Self::imports`].
    pub fn import_pull_request(&self, pull_request: &PullRequest, open: bool) -> Result<()> {
        let change_id = pull_request.change()?;
        if !self.imports(&change_id, pull_request.is_cross_repository, open)? {
            return Ok(());
        }
        self.store.import_forge_events(&change_id, &pull_request.events()?)
    }

    /// What exporting would do: for each open change you own that lands into one parent, open
    /// its forge change once it is up for review, or bring that forge change's title and parent
    /// level with it. A forge event folds after every write that did not see it, so a change
    /// differs from its forge change only by writes made knowing what the forge had.
    pub fn forge_exports(&self) -> Result<Vec<ForgeExport>> {
        self.store.query(|txn| {
            let you = txn.identity()?;
            let mut exports = Vec::new();
            for change in changes_under(&txn.repo, ChangeIdRef::LOG_REF_PREFIX)? {
                let metadata = txn.metadata(&change)?;
                // TODO-someday(joel): a change with several parents has no one branch to be its base.
                let [parent] = metadata.parents.iter().collect::<Vec<_>>()[..] else { continue };
                if metadata.archived || !metadata.owners.contains(&you) {
                    continue;
                }
                match metadata.forge()? {
                    None if metadata.reviewing == Reviewing::None => {}
                    None => exports.push(ForgeExport::Open {
                        title: metadata.title.clone().unwrap_or_else(|| change.to_string()),
                        parent: parent.clone(),
                        change,
                    }),
                    Some(forge) => {
                        // A forge change cannot go untitled, so a cleared title stays here.
                        let title = metadata.title.clone().filter(|_| metadata.title != forge.title);
                        let parent = (forge.parents != metadata.parents).then(|| parent.clone());
                        if title.is_some() || parent.is_some() {
                            exports.push(ForgeExport::Edit { change, title, parent });
                        }
                    }
                }
            }
            Ok(exports)
        })
    }

    /// Record in `change_id`'s log those of `events`, from its forge change's history, that it
    /// does not yet hold.
    pub fn import_forge_events(&self, change_id: &ChangeIdRef, events: &[ForgeEvent]) -> Result<()> {
        self.store.import_forge_events(change_id, events)
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
            self.store.transact(&BTreeSet::new(), &[], &[insert], &[], |_txn, [], [_branch], []| Ok(()))?;
            return Ok(false);
        }
        self.store.transact(&BTreeSet::new(), &[], &[BranchOp::Update(change_id)], &[], |txn, [], [branch], []| {
            if txn.is_predecessor(origin, branch.tip)? {
                return Ok(branch.tip != origin);
            }
            if !txn.is_predecessor(branch.tip, origin)? {
                Err("diverged from origin")?;
            }
            let from = branch.tip;
            branch.tip = origin;
            if let Some(workspace) = branch.workspace()?
                && txn.workspace(workspace.to_ref())?.fast_forward_conflicts(from, branch)?
            {
                Err(format!("local changes in workspace {workspace} conflict with origin's"))?;
            }
            Ok(false)
        })
    }
}

/// The changes named by the refs under `prefix`.
fn changes_under(repo: &gix::Repository, prefix: &str) -> Result<Vec<ChangeId>> {
    let mut changes = Vec::new();
    for reference in repo.references()?.prefixed(prefix)? {
        let name = reference?.name().as_bstr().to_str()?.to_owned();
        changes.push(name.strip_prefix(prefix).expect("listed by this prefix").parse()?);
    }
    Ok(changes)
}

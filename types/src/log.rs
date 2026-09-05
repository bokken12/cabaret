//! The log each change's metadata is stored as: append-only entries behind a ref, folded on
//! read and merged by union across devices.

use gix::{
    ObjectId, Repository,
    objs::{
        Tree,
        tree::{Entry, EntryKind},
    },
};
use serde::{Deserialize, Serialize};

use crate::{
    change_id::ChangeId, error::Result, identity::Identity, repo_path::RepoPath, revision::RevisionRange,
    timestamp::TimestampMs, tree_id::TreeId,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum LogAction {
    AddOwner { owner: Identity },
    AddParent { parent: ChangeId },
    Forget { reviewer: Identity, file: RepoPath },
    Mark { reviewer: Identity, file: RepoPath, range: RevisionRange },
    RemoveOwner { owner: Identity },
    RemoveParent { parent: ChangeId },
    SetArchived { archived: bool },
    SetDescription { description: Option<String> },
    SetPermanent { permanent: bool },
    SetTitle { title: Option<String> },
}

// TODO-someday(joel): move log to its own crate?
// TODO-someday(joel): allow format evolution. protos? versioned?
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: TimestampMs,
    pub user: Identity,
    #[serde(flatten)]
    pub action: LogAction,
}

const LOG_FILE: &str = "log.jsonl";

fn text(repo: &Repository, commit: ObjectId) -> Result<String> {
    let tree = repo.find_commit(commit)?.tree()?;
    let entry = tree.find_entry(LOG_FILE).ok_or_else(|| format!("log commit {commit} has no {LOG_FILE}"))?;
    let blob = entry.object()?.try_into_blob()?;
    Ok(std::str::from_utf8(&blob.data)?.to_owned())
}

/// The entries of the log at `commit`, oldest first.
pub fn read(repo: &Repository, commit: ObjectId) -> Result<Vec<LogEntry>> {
    text(repo, commit)?.lines().map(|line| Ok(serde_json::from_str(line)?)).collect()
}

/// `entries` as they are stored: one JSON object per line.
pub fn render(entries: &[LogEntry]) -> Result<String> {
    let mut text = String::new();
    for entry in entries {
        text.push_str(&serde_json::to_string(entry)?);
        text.push('\n');
    }
    Ok(text)
}

/// The tree of the log commit that follows `previous` with `appended` (see [`render`]) on the end.
pub fn write(repo: &Repository, previous: Option<ObjectId>, appended: &str) -> Result<TreeId> {
    let mut contents = match previous {
        Some(commit) => text(repo, commit)?,
        None => String::new(),
    };
    contents.push_str(appended);
    let blob = repo.write_blob(contents)?.detach();
    let entry = Entry { mode: EntryKind::Blob.into(), filename: LOG_FILE.into(), oid: blob };
    Ok(TreeId(repo.write_object(&Tree { entries: vec![entry] })?.detach()))
}

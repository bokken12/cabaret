//! Shared test fixture; each test binary uses the subset it needs.
#![allow(dead_code)]

use std::{collections::BTreeMap, fs};

use cabaret_lib::{Cabaret, ChangeId, PreparedMerge};
use gix::{ObjectId, objs::tree::EntryKind};

pub type Files<'a> = &'a [(&'a str, &'a str)];

pub struct Fixture {
    _dir: tempfile::TempDir,
    pub cabaret: Cabaret,
}

impl Fixture {
    pub fn new() -> Self {
        let dir = tempfile::TempDir::new().unwrap();
        gix::init(dir.path()).unwrap();
        let repo = gix::open_opts(dir.path(), gix::open::Options::isolated()).unwrap();
        let config_path = repo.git_dir().join("config");
        let config = fs::read_to_string(&config_path).unwrap();
        fs::write(config_path, format!("{config}[user]\n\tname = Alice Test\n\temail = alice@example.com\n")).unwrap();
        let repo = gix::open_opts(dir.path(), gix::open::Options::isolated()).unwrap();
        Self { _dir: dir, cabaret: Cabaret { repo } }
    }

    pub fn repo(&self) -> &gix::Repository { &self.cabaret.repo }

    pub fn commit(&self, reference: &str, files: Files, parents: &[ObjectId]) -> ObjectId {
        let tree = write_tree(self.repo(), files);
        self.repo().commit(reference, "test", tree, parents.iter().copied()).unwrap().detach()
    }

    pub fn branch(&self, name: &str, target: ObjectId) {
        self.repo()
            .reference(format!("refs/heads/{name}"), target, gix::refs::transaction::PreviousValue::Any, "test branch")
            .unwrap();
    }

    pub fn checkout(&self, change: &str, files: Files) {
        fs::write(self.repo().git_dir().join("HEAD"), format!("ref: refs/heads/{change}\n")).unwrap();
        for (path, content) in files {
            let path = self.repo().workdir().unwrap().join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
        let head_tree = self.repo().head_commit().unwrap().tree_id().unwrap();
        let mut index = self.repo().index_from_tree(&head_tree).unwrap();
        index.write(gix::index::write::Options::default()).unwrap();
    }

    /// Initialize `change`'s (empty) log and record its parents.
    pub fn set_parents(&self, change: &str, parents: &[&str]) {
        let change: ChangeId = change.parse().unwrap();
        let blob = self.repo().write_blob(b"").unwrap().detach();
        let tree = gix::objs::Tree {
            entries: vec![gix::objs::tree::Entry {
                mode: EntryKind::Blob.into(),
                filename: "log.jsonl".into(),
                oid: blob,
            }],
        };
        let tree = self.repo().write_object(&tree).unwrap().detach();
        self.repo().commit(format!("refs/cabaret/changes/{change}"), "create", tree, Vec::<ObjectId>::new()).unwrap();
        for parent in parents {
            self.cabaret.add_parent(&change, &parent.parse().unwrap()).unwrap();
        }
    }

    pub fn prepare(&self, into: &str, from: &str) -> cabaret_lib::Result<Option<PreparedMerge>> {
        self.cabaret.prepare_merge(&into.parse::<ChangeId>().unwrap(), &from.parse().unwrap())
    }

    /// Merge `from` into `child`, committing conflicts, as `cab change rebase` does.
    /// `None` means already up to date.
    pub fn merge(&self, from: &str) -> cabaret_lib::Result<Option<Vec<String>>> {
        let Some(merge) = self.prepare("child", from)? else { return Ok(None) };
        let conflicts = merge.conflicts().to_vec();
        self.cabaret.commit_merge(merge, format!("merge {from}"))?;
        Ok(Some(conflicts))
    }

    pub fn tip(&self, change: &str) -> (ObjectId, Vec<ObjectId>) {
        let commit = self.repo().find_reference(&format!("refs/heads/{change}")).unwrap().peel_to_commit().unwrap();
        (commit.id, commit.parent_ids().map(gix::Id::detach).collect())
    }

    pub fn worktree_file(&self, path: &str) -> String {
        fs::read_to_string(self.repo().workdir().unwrap().join(path)).unwrap()
    }

    pub fn revision_file(&self, revision: ObjectId, path: &str) -> String {
        let tree = self.repo().find_commit(revision).unwrap().tree().unwrap();
        let entry = tree.lookup_entry_by_path(path).unwrap().unwrap();
        String::from_utf8(entry.object().unwrap().data.clone()).unwrap()
    }

    /// Register a linked worktree with `branch` checked out, as `git worktree add` would.
    pub fn add_workspace(&self, name: &str, branch: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::TempDir::new().unwrap();
        let workspace = fs::canonicalize(dir.path()).unwrap();
        let meta = fs::canonicalize(self.repo().git_dir()).unwrap().join("worktrees").join(name);
        fs::create_dir_all(&meta).unwrap();
        fs::write(meta.join("HEAD"), format!("ref: refs/heads/{branch}\n")).unwrap();
        fs::write(meta.join("commondir"), "../..\n").unwrap();
        fs::write(meta.join("gitdir"), format!("{}\n", workspace.join(".git").display())).unwrap();
        fs::write(workspace.join(".git"), format!("gitdir: {}\n", meta.display())).unwrap();
        (dir, workspace)
    }
}

pub fn write_tree(repo: &gix::Repository, files: Files) -> ObjectId {
    let mut entries = Vec::new();
    let mut subdirs: BTreeMap<&str, Vec<(&str, &str)>> = BTreeMap::new();
    for (path, content) in files {
        match path.split_once('/') {
            None => entries.push(gix::objs::tree::Entry {
                mode: EntryKind::Blob.into(),
                filename: (*path).into(),
                oid: repo.write_blob(content.as_bytes()).unwrap().detach(),
            }),
            Some((dir, rest)) => subdirs.entry(dir).or_default().push((rest, content)),
        }
    }
    for (dir, files) in subdirs {
        entries.push(gix::objs::tree::Entry {
            mode: EntryKind::Tree.into(),
            filename: dir.into(),
            oid: write_tree(repo, &files),
        });
    }
    entries.sort();
    repo.write_object(&gix::objs::Tree { entries }).unwrap().detach()
}

/// A repo where `child` (checked out) and its parent `main` have both advanced from a shared base.
pub fn diverged(base: Files, child: Files, main: Files) -> Fixture {
    let fixture = Fixture::new();
    let root = fixture.commit("refs/heads/main", base, &[]);
    fixture.commit("refs/heads/child", child, &[root]);
    fixture.commit("refs/heads/main", main, &[root]);
    fixture.checkout("child", child);
    fixture
}

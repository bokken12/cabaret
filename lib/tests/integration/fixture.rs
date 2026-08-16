//! A repo with a `Cabaret` on it, for integration tests to build state in.

use std::{collections::BTreeMap, fs};

use cabaret_lib::{Cabaret, ChangeId, Revision, TreeId};
use gix::objs::tree::EntryKind;

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

    pub fn commit(&self, reference: &str, files: Files, parents: &[Revision]) -> Revision {
        let tree = write_tree(self.repo(), files);
        Revision(self.repo().commit(reference, "test", tree, parents.iter().copied()).unwrap().detach())
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
        self.repo().commit(format!("refs/cabaret/changes/{change}"), "create", tree, Vec::<Revision>::new()).unwrap();
        for parent in parents {
            self.cabaret.add_parent(&change, &parent.parse().unwrap()).unwrap();
        }
    }
}

pub fn write_tree(repo: &gix::Repository, files: Files) -> TreeId {
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
            oid: write_tree(repo, &files).0,
        });
    }
    entries.sort();
    TreeId(repo.write_object(&gix::objs::Tree { entries }).unwrap().detach())
}

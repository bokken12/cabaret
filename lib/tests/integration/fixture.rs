//! A repo with a `Cabaret` on it, for integration tests to build state in.
//!
//! Tests pick up one of two standard scenes — [`duo`], a two-change stack to mutate, or
//! [`troupe`], a rich graph to read — and assert about the one operation they perform.
//! Each scene's full state is pinned by a snapshot beside its builder.

// TODO(joel): fixture naming should make relationships self-evident

use std::{
    cell::Cell,
    collections::{BTreeMap, BTreeSet},
    fmt::Write as _,
    fs,
};

use cabaret_lib::{Cabaret, ChangeId, Identity, Revision, TreeId};
use expect_test::expect;
use gix::objs::tree::EntryKind;

pub fn alice() -> Identity { Identity("alice@example.com".into()) }
pub fn bob() -> Identity { Identity("bob@example.com".into()) }
pub fn carol() -> Identity { Identity("carol@example.com".into()) }
pub fn dan() -> Identity { Identity("dan@example.com".into()) }

pub type Files<'a> = &'a [(&'a str, &'a str)];

pub struct Fixture {
    _dir: tempfile::TempDir,
    pub cabaret: Cabaret,
    /// Commit timestamps count up from a fixed epoch so hashes are stable across runs
    /// and may appear literally in snapshots.
    clock: Cell<i64>,
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
        Self { _dir: dir, cabaret: Cabaret { repo }, clock: Cell::new(978_307_200) }
    }

    pub fn repo(&self) -> &gix::Repository { &self.cabaret.repo }

    pub fn tip(&self, change: &str) -> Revision { self.cabaret.tip(&change.parse().unwrap()).unwrap() }

    fn commit_tree(&self, branch: &str, tree: TreeId, parents: &[Revision]) -> Revision {
        let time = gix::date::Time { seconds: self.clock.replace(self.clock.get() + 1), offset: 0 };
        let signature = gix::actor::Signature { name: "Alice Test".into(), email: alice().0.into(), time };
        let mut buf = gix::date::parse::TimeBuf::default();
        let signature = signature.to_ref(&mut buf);
        let id = self
            .repo()
            .commit_as(signature, signature, format!("refs/heads/{branch}"), "test", tree, parents.iter().copied())
            .unwrap();
        Revision(id.detach())
    }

    /// Root `branch` at a commit of exactly `files`, without a change log: a trunk.
    pub fn root(&self, branch: &str, files: Files) -> Revision {
        let files: BTreeMap<String, String> =
            files.iter().map(|(path, content)| ((*path).into(), (*content).into())).collect();
        self.commit_tree(branch, write_tree(self.repo(), &files), &[])
    }

    /// Create `change` on `parent` owned by `owner`, through the real creation path.
    pub fn create(&self, change: &str, parent: &str, owner: &Identity) {
        self.cabaret.create_change(&change.parse().unwrap(), &parent.parse().unwrap(), owner).unwrap();
    }

    /// Commit `files` on top of `change`'s tip, carrying the rest of its tree forward.
    pub fn extend(&self, change: &str, files: Files) -> Revision {
        let tip = self.tip(change);
        let mut all = self.files_at(tip);
        for (path, content) in files {
            all.insert((*path).into(), (*content).into());
        }
        self.commit_tree(change, write_tree(self.repo(), &all), &[tip])
    }

    /// Merge `other`'s tip into `change` and commit `files` on the union.
    pub fn join(&self, change: &str, other: &str, files: Files) -> Revision {
        let (tip, other_tip) = (self.tip(change), self.tip(other));
        let mut all = self.files_at(tip);
        all.extend(self.files_at(other_tip));
        for (path, content) in files {
            all.insert((*path).into(), (*content).into());
        }
        self.commit_tree(change, write_tree(self.repo(), &all), &[tip, other_tip])
    }

    pub fn own(&self, change: &str, owner: &Identity) {
        self.cabaret.add_owner(&change.parse().unwrap(), owner).unwrap();
    }

    pub fn title(&self, change: &str, title: &str) {
        self.cabaret.set_title(&change.parse().unwrap(), Some(title.into())).unwrap();
    }

    pub fn describe(&self, change: &str, description: &str) {
        self.cabaret.set_description(&change.parse().unwrap(), Some(description.into())).unwrap();
    }

    /// Point HEAD at `change` and materialize its tip in the worktree and index.
    pub fn checkout(&self, change: &str) {
        fs::write(self.repo().git_dir().join("HEAD"), format!("ref: refs/heads/{change}\n")).unwrap();
        for (path, content) in self.files_at(self.tip(change)) {
            let path = self.repo().workdir().unwrap().join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
        let head_tree = self.repo().head_commit().unwrap().tree_id().unwrap();
        let mut index = self.repo().index_from_tree(&head_tree).unwrap();
        index.write(gix::index::write::Options::default()).unwrap();
    }

    fn files_at(&self, revision: Revision) -> BTreeMap<String, String> {
        fn walk(tree: &gix::Tree<'_>, prefix: &str, out: &mut BTreeMap<String, String>) {
            for entry in tree.iter() {
                let entry = entry.unwrap();
                let name = entry.filename().to_string();
                let path = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
                let object = entry.object().unwrap();
                match object.kind {
                    gix::object::Kind::Tree => walk(&object.into_tree(), &path, out),
                    gix::object::Kind::Blob => {
                        out.insert(path, String::from_utf8(object.data.clone()).unwrap());
                    }
                    kind => panic!("unexpected {kind} in tree"),
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(&self.repo().find_commit(revision.0).unwrap().tree().unwrap(), "", &mut out);
        out
    }

    /// The whole scene as text: HEAD, trunks, then each change with its attributes,
    /// files, and next step.
    pub fn state(&self) -> String {
        let words = |items: Vec<String>| items.join(" ");
        let mut out = String::new();
        let head = self.repo().head_name().unwrap().expect("fixture HEAD is a branch");
        writeln!(out, "HEAD {}", head.shorten()).unwrap();
        let changes: BTreeSet<ChangeId> = self.cabaret.changes().unwrap().into_iter().collect();
        for branch in self.cabaret.branches().unwrap() {
            if !changes.contains(&branch) {
                writeln!(out, "{branch} {}", self.short(&branch)).unwrap();
            }
        }
        for change in &changes {
            let log = self.cabaret.log(change).unwrap();
            writeln!(out, "{change} {}", self.short(change)).unwrap();
            writeln!(out, "  parents {}", words(log.parents.iter().map(ToString::to_string).collect())).unwrap();
            if !log.owners.is_empty() {
                writeln!(out, "  owners {}", words(log.owners.iter().map(ToString::to_string).collect())).unwrap();
            }
            if let Some(title) = &log.title {
                writeln!(out, "  title {title}").unwrap();
            }
            if let Some(description) = &log.description {
                writeln!(out, "  description {description}").unwrap();
            }
            let files = self.files_at(self.cabaret.tip(change).unwrap());
            writeln!(out, "  files {}", words(files.into_keys().collect())).unwrap();
            writeln!(out, "  step {}", self.cabaret.next_step(change).unwrap()).unwrap();
        }
        out
    }

    fn short(&self, change: &ChangeId) -> String { self.cabaret.tip(change).unwrap().0.to_hex_with_len(8).to_string() }
}

fn write_tree(repo: &gix::Repository, files: &BTreeMap<String, String>) -> TreeId {
    let mut entries = Vec::new();
    let mut subdirs: BTreeMap<&str, BTreeMap<String, String>> = BTreeMap::new();
    for (path, content) in files {
        match path.split_once('/') {
            None => entries.push(gix::objs::tree::Entry {
                mode: EntryKind::Blob.into(),
                filename: path.as_str().into(),
                oid: repo.write_blob(content.as_bytes()).unwrap().detach(),
            }),
            Some((dir, rest)) => {
                subdirs.entry(dir).or_default().insert(rest.into(), content.clone());
            }
        }
    }
    for (dir, files) in &subdirs {
        entries.push(gix::objs::tree::Entry {
            mode: EntryKind::Tree.into(),
            filename: (*dir).into(),
            oid: write_tree(repo, files).0,
        });
    }
    entries.sort();
    TreeId(repo.write_object(&gix::objs::Tree { entries }).unwrap().detach())
}

/// The small scene: bob's `infra` on main, alice's `feature` stacked on it and checked
/// out. Mutation tests start here and, say, extend main to strand the stack.
pub fn duo() -> Fixture {
    let fixture = Fixture::new();
    fixture.root("main", &[("base.txt", "base\n")]);
    fixture.create("infra", "main", &bob());
    fixture.extend("infra", &[("infra.txt", "infra\n")]);
    fixture.create("feature", "infra", &alice());
    fixture.extend("feature", &[("feature.txt", "feature\n")]);
    fixture.checkout("feature");
    fixture
}

#[test]
fn duo_scene() {
    expect![[r"
        HEAD feature
        main ee8d777a
        feature 5a2f333a
          parents infra
          owners alice@example.com
          files base.txt feature.txt infra.txt
          step land
        infra a31ff052
          parents main
          owners bob@example.com
          files base.txt infra.txt
          step land
    "]]
    .assert_eq(&duo().state());
}

/// The large scene, for reading: a co-owned base carrying two sibling features that a
/// diamond joins, an independent change whose child it stranded, and an empty change.
pub fn troupe() -> Fixture {
    let fixture = Fixture::new();
    fixture.root("main", &[("README.md", "# demo\n"), ("src/app.rs", "fn main() {}\n")]);

    fixture.create("infra-core", "main", &alice());
    fixture.extend("infra-core", &[("src/infra.rs", "pub fn plumb() {}\n")]);
    fixture.own("infra-core", &bob());
    fixture.title("infra-core", "Core plumbing");

    fixture.create("api-routes", "infra-core", &alice());
    fixture.extend("api-routes", &[("src/api.rs", "pub fn route() {}\n")]);
    fixture.title("api-routes", "Route the API");

    fixture.create("ui-widgets", "infra-core", &bob());
    fixture.extend("ui-widgets", &[("src/ui.rs", "pub fn widget() {}\n")]);

    fixture.create("integration", "api-routes", &carol());
    fixture.cabaret.add_parent(&"integration".parse().unwrap(), &"ui-widgets".parse().unwrap()).unwrap();
    fixture.join("integration", "ui-widgets", &[("tests/e2e.rs", "#[test]\nfn ok() {}\n")]);

    fixture.create("docs-polish", "main", &carol());
    fixture.extend("docs-polish", &[("docs/guide.md", "guide\n")]);
    fixture.title("docs-polish", "Polish the guide");
    fixture.create("release-notes", "docs-polish", &dan());
    fixture.extend("release-notes", &[("docs/notes.md", "notes\n")]);
    fixture.extend("docs-polish", &[("docs/guide.md", "guide, edited\n")]);

    fixture.create("experiment", "main", &bob());
    fixture.describe("experiment", "Try the new widget layout");

    fixture.checkout("main");
    fixture
}

#[test]
fn troupe_scene() {
    expect![[r"
        HEAD main
        main 70c9fc42
        api-routes 918769d7
          parents infra-core
          owners alice@example.com
          title Route the API
          files README.md src/api.rs src/app.rs src/infra.rs
          step land
        docs-polish 2c6cc60d
          parents main
          owners carol@example.com
          title Polish the guide
          files README.md docs/guide.md src/app.rs
          step land
        experiment 70c9fc42
          parents main
          owners bob@example.com
          description Try the new widget layout
          files README.md src/app.rs
          step add code
        infra-core ca64cf68
          parents main
          owners alice@example.com bob@example.com
          title Core plumbing
          files README.md src/app.rs src/infra.rs
          step land
        integration 011ec31f
          parents api-routes ui-widgets
          owners carol@example.com
          files README.md src/api.rs src/app.rs src/infra.rs src/ui.rs tests/e2e.rs
          step land parents
        release-notes ddcccd00
          parents docs-polish
          owners dan@example.com
          files README.md docs/guide.md docs/notes.md src/app.rs
          step rebase
        ui-widgets 4b24c865
          parents infra-core
          owners bob@example.com
          files README.md src/app.rs src/infra.rs src/ui.rs
          step land
    "]]
    .assert_eq(&troupe().state());
}

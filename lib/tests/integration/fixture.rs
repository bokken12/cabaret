//! A repo with a `Cabaret` on it, for integration tests to build state in.
//!
//! Changes are named for the shape of the graph around them or for the state they are in,
//! never for what they pretend to implement: `stack-middle` sits between `stack-bottom` and
//! `stack-top`, `empty` has no diff, `behind-child`'s parent has moved on without it. Every
//! change with a diff adds one file named after itself. The standard [`scene`] holds one of
//! each shape; its full state is pinned by the snapshot beside it, so a test can name a change
//! and the reader can look up exactly what it is.

use std::{
    cell::Cell,
    collections::{BTreeMap, VecDeque},
    fmt::Write as _,
    fs,
};

use cabaret_lib::{
    cabaret::Cabaret,
    change::ChangeSnapshot,
    types::{ChangeId, ChangedFile, Identity, Revision, TreeId},
};
use expect_test::expect;
use gix::{objs::tree::EntryKind, refs::transaction::PreviousValue};

pub fn alice() -> Identity { Identity("alice@example.com".into()) }
pub fn bob() -> Identity { Identity("bob@example.com".into()) }
pub fn carol() -> Identity { Identity("carol@example.com".into()) }

pub type Files<'a> = &'a [(&'a str, &'a str)];

pub struct Fixture {
    _dir: tempfile::TempDir,
    pub cabaret: Cabaret,
    repo: gix::Repository,
    /// Commit timestamps count up from a fixed epoch so hashes are stable across runs
    /// and may appear literally in snapshots.
    clock: Cell<i64>,
}

pub fn id(change: &str) -> ChangeId { change.parse().unwrap() }

impl Fixture {
    pub fn new() -> Self {
        let dir = tempfile::TempDir::new().unwrap();
        let repo = gix::init(dir.path()).unwrap();
        let config_path = repo.git_dir().join("config");
        let config = fs::read_to_string(&config_path).unwrap();
        fs::write(config_path, format!("{config}[user]\n\tname = Alice Test\n\temail = alice@example.com\n")).unwrap();
        let cabaret = Cabaret::open(dir.path()).unwrap();
        let repo = gix::open(dir.path()).unwrap();
        Self { _dir: dir, cabaret, repo, clock: Cell::new(978_307_200) }
    }

    pub fn snapshot(&self, change: &str) -> ChangeSnapshot { self.cabaret.snapshot(&id(change)).unwrap() }

    pub fn tip(&self, change: &str) -> Revision { self.snapshot(change).tip }

    fn commit_tree(&self, tree: TreeId, parents: &[Revision]) -> Revision {
        let time = gix::date::Time { seconds: self.clock.replace(self.clock.get() + 1), offset: 0 };
        let author = gix::actor::Signature { name: "Alice Test".into(), email: alice().0.into(), time };
        let commit = gix::objs::Commit {
            tree: tree.0,
            parents: parents.iter().map(|revision| revision.0).collect(),
            author: author.clone(),
            committer: author,
            encoding: None,
            message: "fixture".into(),
            extra_headers: Vec::new(),
        };
        Revision(self.repo.write_object(&commit).unwrap().detach())
    }

    fn move_branch(&self, change: &str, revision: Revision) {
        self.repo.reference(id(change).branch_ref(), revision.0, PreviousValue::Any, "fixture").unwrap();
    }

    /// A plain git branch at a root commit of exactly `files`, with no log: a trunk.
    pub fn root(&self, change: &str, files: Files) {
        let files = files.iter().map(|(path, content)| ((*path).into(), (*content).into())).collect();
        self.move_branch(change, self.commit_tree(write_tree(&self.repo, &files), &[]));
    }

    /// A plain git branch at `parent`'s tip, with no log: someone else's work, made without cabaret.
    pub fn branch(&self, change: &str, parent: &str) { self.move_branch(change, self.tip(parent)); }

    /// Create `change` on `parent` owned by `owner`, through the real creation path.
    pub fn create(&self, change: &str, parent: &str, owner: &Identity) {
        self.cabaret.create(&id(change), &id(parent), owner).unwrap();
    }

    /// Commit `files` on top of `change`'s tip, carrying the rest of its tree forward.
    pub fn commit(&self, change: &str, files: Files) -> Revision {
        let tip = self.tip(change);
        let mut all = self.files_at(tip);
        for (path, content) in files {
            all.insert((*path).into(), (*content).into());
        }
        let revision = self.commit_tree(write_tree(&self.repo, &all), &[tip]);
        self.move_branch(change, revision);
        revision
    }

    /// Commit the removal of `paths` from `change`'s tip.
    pub fn remove(&self, change: &str, paths: &[&str]) -> Revision {
        let tip = self.tip(change);
        let mut all = self.files_at(tip);
        for path in paths {
            all.remove(*path).expect("removed file exists");
        }
        let revision = self.commit_tree(write_tree(&self.repo, &all), &[tip]);
        self.move_branch(change, revision);
        revision
    }

    /// Merge `other`'s tip into `change` and commit `files` on the union.
    pub fn merge(&self, change: &str, other: &str, files: Files) -> Revision {
        let (tip, other_tip) = (self.tip(change), self.tip(other));
        let mut all = self.files_at(tip);
        all.extend(self.files_at(other_tip));
        for (path, content) in files {
            all.insert((*path).into(), (*content).into());
        }
        let revision = self.commit_tree(write_tree(&self.repo, &all), &[tip, other_tip]);
        self.move_branch(change, revision);
        revision
    }

    /// Point HEAD at `change` and materialize its tip in the worktree and index.
    pub fn checkout(&self, change: &str) { self.populate(&self.repo, change); }

    /// Detach HEAD at `change`'s tip.
    pub fn detach(&self, change: &str) {
        fs::write(self.repo.git_dir().join("HEAD"), format!("{}\n", self.tip(change))).unwrap();
    }

    /// The main working directory as text; see [`worktree`].
    pub fn worktree(&self) -> String { worktree(&self.repo) }

    pub fn write(&self, path: &str, content: &str) {
        fs::write(self.repo.workdir().unwrap().join(path), content).unwrap();
    }

    pub fn exists(&self, path: &str) -> bool { self.repo.workdir().unwrap().join(path).exists() }

    /// A linked worktree with `change` checked out, as `git worktree add` makes.
    pub fn link_workspace(&self, change: &str) -> (tempfile::TempDir, gix::Repository) {
        let dir = tempfile::TempDir::new().unwrap();
        let workspace = fs::canonicalize(dir.path()).unwrap();
        let admin = self.repo.git_dir().join("worktrees").join(change);
        fs::create_dir_all(&admin).unwrap();
        fs::write(admin.join("commondir"), "../..\n").unwrap();
        fs::write(admin.join("gitdir"), format!("{}\n", workspace.join(".git").display())).unwrap();
        fs::write(workspace.join(".git"), format!("gitdir: {}\n", admin.display())).unwrap();
        fs::write(admin.join("HEAD"), format!("ref: refs/heads/{change}\n")).unwrap();
        let repo = gix::open(&workspace).unwrap();
        self.populate(&repo, change);
        (dir, repo)
    }

    /// Point `repo`'s HEAD at `change` and write its tip's files and index, over whatever is there.
    fn populate(&self, repo: &gix::Repository, change: &str) {
        fs::write(repo.git_dir().join("HEAD"), format!("ref: refs/heads/{change}\n")).unwrap();
        for (path, content) in self.files_at(self.tip(change)) {
            let path = repo.workdir().unwrap().join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
        let tree = repo.head_commit().unwrap().tree_id().unwrap();
        let mut index = repo.index_from_tree(&tree).unwrap();
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
        walk(&self.repo.find_commit(revision.0).unwrap().tree().unwrap(), "", &mut out);
        out
    }

    /// The whole scene as text: HEAD, then [`Self::show`] of every change.
    pub fn state(&self) -> String {
        let head = self.repo.head_name().unwrap().expect("fixture HEAD is a branch");
        let mut out = format!("HEAD {}\n", head.shorten());
        let mut changes = self.cabaret.changes().unwrap();
        changes.sort();
        for change in changes {
            out.push_str(&self.show(&change.to_string()));
        }
        out
    }

    /// [`Self::show`] without the tip hash, which a merge commit stamps with the current time.
    pub fn describe(&self, change: &str) -> String {
        let shown = self.show(change);
        let (first, rest) = shown.split_once('\n').unwrap();
        format!("{}\n{rest}", first.split_once(' ').unwrap().0)
    }

    /// One change as text: its tip, the workspace holding it, the parents it targets and the declared ones when those
    /// differ, its attributes, its base, and the files it changes against that base. The base is
    /// named for the nearest ancestor whose tip it is, else it is a bare hash.
    pub fn show(&self, change: &str) -> String {
        let words = |items: Vec<String>| items.join(" ");
        let snapshot = self.cabaret.snapshot(&id(change)).unwrap();
        let mut out = format!("{change} {}\n", short(snapshot.tip));
        if let Some(workspace) = &snapshot.workspace {
            writeln!(out, "  workspace {workspace}").unwrap();
        }
        if !snapshot.parents.is_empty() {
            writeln!(out, "  parents {}", words(snapshot.parents.iter().map(ToString::to_string).collect())).unwrap();
        }
        if snapshot.declared_parents != snapshot.parents {
            let declared = match snapshot.declared_parents.is_empty() {
                true => "(none)".into(),
                false => words(snapshot.declared_parents.iter().map(ToString::to_string).collect()),
            };
            writeln!(out, "  declared {declared}").unwrap();
        }
        if !snapshot.owners.is_empty() {
            writeln!(out, "  owners {}", words(snapshot.owners.iter().map(ToString::to_string).collect())).unwrap();
        }
        if snapshot.archived {
            writeln!(out, "  archived").unwrap();
        }
        if snapshot.permanent {
            writeln!(out, "  permanent").unwrap();
        }
        if let Some(title) = &snapshot.title {
            writeln!(out, "  title {title}").unwrap();
        }
        if let Some(description) = &snapshot.description {
            writeln!(out, "  description {description}").unwrap();
        }
        match self.cabaret.base(&id(change)) {
            Err(error) => writeln!(out, "  base {error:?}").unwrap(),
            Ok(base) => {
                let base = base.map_or("(none)".into(), |base| self.ancestor_at(change, base));
                writeln!(out, "  base {base}").unwrap();
                let files = self.cabaret.changed_files(&id(change), &[]).unwrap();
                let diff = match files.is_empty() {
                    true => "(empty)".into(),
                    false => words(files.iter().map(file).collect()),
                };
                writeln!(out, "  diff {diff}").unwrap();
            }
        }
        out
    }

    /// The nearest ancestor of `change` whose tip is `revision`, else its short hash.
    fn ancestor_at(&self, change: &str, revision: Revision) -> String {
        let mut frontier: VecDeque<ChangeId> =
            self.cabaret.snapshot(&id(change)).unwrap().parents.into_iter().collect();
        while let Some(ancestor) = frontier.pop_front() {
            let snapshot = self.cabaret.snapshot(&ancestor).unwrap();
            if snapshot.tip == revision {
                return ancestor.to_string();
            }
            frontier.extend(snapshot.parents);
        }
        short(revision)
    }
}

/// A working directory as text: whether it is clean, then every file with its content.
pub fn worktree(repo: &gix::Repository) -> String {
    let workdir = repo.workdir().unwrap();
    let mut out = match repo.is_dirty().unwrap() {
        true => "dirty\n".to_string(),
        false => "clean\n".to_string(),
    };
    let mut paths = walkdir(workdir);
    paths.sort();
    for path in paths {
        let content = fs::read_to_string(&path).unwrap();
        writeln!(out, "{} {content:?}", path.strip_prefix(workdir).unwrap().display()).unwrap();
    }
    out
}

fn walkdir(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.file_name().unwrap() == ".git" {
            continue;
        }
        match path.is_dir() {
            true => out.extend(walkdir(&path)),
            false => out.push(path),
        }
    }
    out
}

pub fn short(revision: Revision) -> String { revision.0.to_hex_with_len(8).to_string() }

fn file(file: &ChangedFile) -> String {
    match file {
        ChangedFile::Added { path } => format!("+{path}"),
        ChangedFile::Deleted { path } => format!("-{path}"),
        ChangedFile::Modified { path } => format!("~{path}"),
        ChangedFile::Renamed { from, path } => format!("{from}->{path}"),
        ChangedFile::Copied { from, path } => format!("{from}=>{path}"),
    }
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

/// Every shape once, all rooted on `main`, with `single` checked out:
///
/// - `main`: a plain git branch with no log; the default branch everything targets.
/// - `unlogged`: a plain git branch off main with no log, so its parent is implied.
/// - `single`: the plainest change, one file on main.
/// - `stack-bottom` → `stack-middle` → `stack-top`: a linear stack.
/// - `fork-base` splitting into `fork-left` and `fork-right`, rejoined by `fork-join`, a change with two parents whose
///   tip merges both.
/// - `empty`: created on main and never committed to.
/// - `advanced-parent` → `behind-child`: the parent committed again after the child forked, so the child's base is no
///   longer its parent's tip.
/// - `archived` → `child-of-archived`: the parent is archived, so the child's effective parent is main.
/// - `co-owned`: owned by alice and bob.
/// - `described`: has a title and description.
pub fn scene() -> Fixture {
    let fixture = Fixture::new();
    fixture.root("main", &[("main.txt", "main\n")]);

    fixture.branch("unlogged", "main");
    fixture.commit("unlogged", &[("unlogged.txt", "unlogged\n")]);

    fixture.create("single", "main", &alice());
    fixture.commit("single", &[("single.txt", "single\n")]);

    fixture.create("stack-bottom", "main", &alice());
    fixture.commit("stack-bottom", &[("stack-bottom.txt", "stack-bottom\n")]);
    fixture.create("stack-middle", "stack-bottom", &alice());
    fixture.commit("stack-middle", &[("stack-middle.txt", "stack-middle\n")]);
    fixture.create("stack-top", "stack-middle", &alice());
    fixture.commit("stack-top", &[("stack-top.txt", "stack-top\n")]);

    fixture.create("fork-base", "main", &alice());
    fixture.commit("fork-base", &[("fork-base.txt", "fork-base\n")]);
    fixture.create("fork-left", "fork-base", &alice());
    fixture.commit("fork-left", &[("fork-left.txt", "fork-left\n")]);
    fixture.create("fork-right", "fork-base", &bob());
    fixture.commit("fork-right", &[("fork-right.txt", "fork-right\n")]);
    fixture.create("fork-join", "fork-left", &carol());
    fixture.cabaret.add_parent(&id("fork-join"), &id("fork-right")).unwrap();
    fixture.merge("fork-join", "fork-right", &[("fork-join.txt", "fork-join\n")]);

    fixture.create("empty", "main", &alice());

    fixture.create("advanced-parent", "main", &alice());
    fixture.commit("advanced-parent", &[("advanced-parent.txt", "advanced-parent\n")]);
    fixture.create("behind-child", "advanced-parent", &alice());
    fixture.commit("behind-child", &[("behind-child.txt", "behind-child\n")]);
    fixture.commit("advanced-parent", &[("advanced-parent.txt", "advanced-parent, advanced\n")]);

    fixture.create("archived", "main", &alice());
    fixture.commit("archived", &[("archived.txt", "archived\n")]);
    fixture.create("child-of-archived", "archived", &alice());
    fixture.commit("child-of-archived", &[("child-of-archived.txt", "child-of-archived\n")]);
    fixture.cabaret.archive(&id("archived")).unwrap();

    fixture.create("co-owned", "main", &alice());
    fixture.cabaret.add_owner(&id("co-owned"), &bob()).unwrap();
    fixture.commit("co-owned", &[("co-owned.txt", "co-owned\n")]);

    fixture.create("described", "main", &alice());
    fixture.cabaret.set_title(&id("described"), Some("Described".into())).unwrap();
    fixture.cabaret.set_description(&id("described"), Some("A change with a title and description.".into())).unwrap();
    fixture.commit("described", &[("described.txt", "described\n")]);

    fixture.checkout("single");
    fixture
}

#[test]
fn scene_state() {
    expect![[r"
        HEAD single
        advanced-parent 54a49f30
          parents main
          owners alice@example.com
          base main
          diff +advanced-parent.txt
        archived 8fd049ba
          parents main
          owners alice@example.com
          archived
          base main
          diff +archived.txt
        behind-child 2360539f
          parents advanced-parent
          owners alice@example.com
          base 77cc9daf
          diff +behind-child.txt
        child-of-archived 22e75840
          parents main
          declared archived
          owners alice@example.com
          base main
          diff +archived.txt +child-of-archived.txt
        co-owned 846dd910
          parents main
          owners alice@example.com bob@example.com
          base main
          diff +co-owned.txt
        described 8210a240
          parents main
          owners alice@example.com
          title Described
          description A change with a title and description.
          base main
          diff +described.txt
        empty be64648c
          parents main
          owners alice@example.com
          base main
          diff (empty)
        fork-base b088f3ac
          parents main
          owners alice@example.com
          base main
          diff +fork-base.txt
        fork-join 16934e40
          parents fork-left fork-right
          owners carol@example.com
          base 5e1786ac
          diff +fork-join.txt
        fork-left 3454c042
          parents fork-base
          owners alice@example.com
          base fork-base
          diff +fork-left.txt
        fork-right a7b00c77
          parents fork-base
          owners bob@example.com
          base fork-base
          diff +fork-right.txt
        main be64648c
          base (none)
          diff +main.txt
        single 25e7b9de
          workspace main
          parents main
          owners alice@example.com
          base main
          diff +single.txt
        stack-bottom cf5a0eef
          parents main
          owners alice@example.com
          base main
          diff +stack-bottom.txt
        stack-middle c247222b
          parents stack-bottom
          owners alice@example.com
          base stack-bottom
          diff +stack-middle.txt
        stack-top 48008586
          parents stack-middle
          owners alice@example.com
          base stack-middle
          diff +stack-top.txt
        unlogged b86566a3
          parents main
          declared (none)
          base main
          diff +unlogged.txt
    "]]
    .assert_eq(&scene().state());
}

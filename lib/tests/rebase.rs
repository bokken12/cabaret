use std::{collections::BTreeMap, fs};

use cabaret_lib::{Cabaret, ChangeId, Rebase};
use gix::{ObjectId, objs::tree::EntryKind};

type Files<'a> = &'a [(&'a str, &'a str)];

struct Fixture {
    _dir: tempfile::TempDir,
    cabaret: Cabaret,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::TempDir::new().unwrap();
        gix::init(dir.path()).unwrap();
        let repo = gix::open_opts(dir.path(), gix::open::Options::isolated()).unwrap();
        let config_path = repo.git_dir().join("config");
        let config = fs::read_to_string(&config_path).unwrap();
        fs::write(config_path, format!("{config}[user]\n\tname = Alice Test\n\temail = alice@example.com\n")).unwrap();
        let repo = gix::open_opts(dir.path(), gix::open::Options::isolated()).unwrap();
        Self { _dir: dir, cabaret: Cabaret { repo } }
    }

    fn repo(&self) -> &gix::Repository { &self.cabaret.repo }

    fn commit(&self, reference: &str, files: Files, parents: &[ObjectId]) -> ObjectId {
        let tree = write_tree(self.repo(), files);
        self.repo().commit(reference, "test", tree, parents.iter().copied()).unwrap().detach()
    }

    fn checkout(&self, change: &str, files: Files) {
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

    fn rebase(&self, onto: &str) -> cabaret_lib::Result<Rebase> {
        self.cabaret.rebase(&ChangeId("child".into()), &ChangeId(onto.into()))
    }

    fn tip(&self, change: &str) -> (ObjectId, Vec<ObjectId>) {
        let commit = self.repo().find_reference(&format!("refs/heads/{change}")).unwrap().peel_to_commit().unwrap();
        (commit.id, commit.parent_ids().map(gix::Id::detach).collect())
    }

    fn worktree_file(&self, path: &str) -> String {
        fs::read_to_string(self.repo().workdir().unwrap().join(path)).unwrap()
    }

    /// Register a linked worktree with `branch` checked out, as `git worktree add` would.
    fn add_workspace(&self, name: &str, branch: &str) -> (tempfile::TempDir, std::path::PathBuf) {
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

fn write_tree(repo: &gix::Repository, files: Files) -> ObjectId {
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
fn diverged(base: Files, child: Files, main: Files) -> Fixture {
    let fixture = Fixture::new();
    let root = fixture.commit("refs/heads/main", base, &[]);
    fixture.commit("refs/heads/child", child, &[root]);
    fixture.commit("refs/heads/main", main, &[root]);
    fixture.checkout("child", child);
    fixture
}

#[test]
fn merges_the_parent_into_the_change() {
    let fixture = diverged(
        &[("mine.txt", "original\n"), ("theirs.txt", "original\n")],
        &[("mine.txt", "child edit\n"), ("theirs.txt", "original\n")],
        &[("mine.txt", "original\n"), ("theirs.txt", "main edit\n")],
    );
    let (old_child_tip, _) = fixture.tip("child");
    let (main_tip, _) = fixture.tip("main");

    let Rebase::Merged { conflicts } = fixture.rebase("main").unwrap() else { panic!("expected a merge") };

    assert_eq!(conflicts, Vec::<String>::new());
    assert_eq!(fixture.tip("child").1, vec![old_child_tip, main_tip]);
    assert_eq!(fixture.worktree_file("mine.txt"), "child edit\n");
    assert_eq!(fixture.worktree_file("theirs.txt"), "main edit\n");
    assert!(!fixture.repo().is_dirty().unwrap());
}

#[test]
fn commits_conflicts_with_markers() {
    let fixture = diverged(&[("greeting.txt", "hello\n")], &[("greeting.txt", "hi\n")], &[("greeting.txt", "hey\n")]);

    let Rebase::Merged { conflicts } = fixture.rebase("main").unwrap() else { panic!("expected a merge") };

    assert_eq!(conflicts, vec!["greeting.txt".to_string()]);
    assert_eq!(
        fixture.worktree_file("greeting.txt"),
        "<<<<<<< child\nhi\n||||||| base\nhello\n=======\nhey\n>>>>>>> main\n"
    );
    assert!(!fixture.repo().git_dir().join("MERGE_HEAD").exists());
    assert!(!fixture.repo().is_dirty().unwrap());
}

#[test]
fn applies_additions_and_deletions_to_the_worktree() {
    let fixture = diverged(
        &[("keep.txt", "keep\n"), ("old/gone.txt", "gone\n")],
        &[("keep.txt", "keep\n"), ("old/gone.txt", "gone\n"), ("mine.txt", "mine\n")],
        &[("keep.txt", "keep\n"), ("new/nested/file.txt", "new\n")],
    );

    let Rebase::Merged { conflicts } = fixture.rebase("main").unwrap() else { panic!("expected a merge") };

    assert_eq!(conflicts, Vec::<String>::new());
    assert_eq!(fixture.worktree_file("new/nested/file.txt"), "new\n");
    assert!(!fixture.repo().workdir().unwrap().join("old").exists());
    assert_eq!(fixture.worktree_file("mine.txt"), "mine\n");
    assert!(!fixture.repo().is_dirty().unwrap());
}

#[test]
fn a_second_rebase_is_up_to_date() {
    let fixture = diverged(&[("file.txt", "original\n")], &[("file.txt", "child\n")], &[("other.txt", "main\n")]);

    assert!(matches!(fixture.rebase("main").unwrap(), Rebase::Merged { .. }));
    let tip = fixture.tip("child");

    assert!(matches!(fixture.rebase("main").unwrap(), Rebase::UpToDate));
    assert_eq!(fixture.tip("child"), tip);
}

#[test]
fn rebases_onto_the_named_change() {
    let fixture = Fixture::new();
    let root = fixture.commit("refs/heads/main", &[("file.txt", "original\n")], &[]);
    fixture.commit("refs/heads/child", &[("file.txt", "original\n")], &[root]);
    fixture.commit("refs/heads/main", &[("file.txt", "original\n"), ("main.txt", "main\n")], &[root]);
    fixture.commit("refs/heads/other", &[("file.txt", "original\n"), ("other.txt", "other\n")], &[root]);
    fixture.checkout("child", &[("file.txt", "original\n")]);

    let Rebase::Merged { conflicts } = fixture.rebase("other").unwrap() else { panic!("expected a merge") };
    assert_eq!(conflicts, Vec::<String>::new());
    assert_eq!(fixture.worktree_file("other.txt"), "other\n");
    assert!(!fixture.repo().workdir().unwrap().join("main.txt").exists());
}

#[test]
fn a_change_checked_out_in_another_workspace_refuses_to_rebase() {
    let fixture = diverged(&[("file.txt", "original\n")], &[("file.txt", "child\n")], &[("file.txt", "main\n")]);
    fixture.checkout("main", &[("file.txt", "main\n")]);
    let (_dir, workspace) = fixture.add_workspace("wt", "child");

    let error = fixture.rebase("main").unwrap_err();
    assert_eq!(
        format!("{error:?}"),
        format!("child is checked out in workspace {}; rebase there", workspace.display())
    );
}

#[test]
fn a_dirty_worktree_refuses_to_rebase() {
    let fixture = diverged(&[("file.txt", "original\n")], &[("file.txt", "child\n")], &[("other.txt", "main\n")]);
    fs::write(fixture.repo().workdir().unwrap().join("file.txt"), "uncommitted\n").unwrap();

    let error = fixture.rebase("main").unwrap_err();
    assert_eq!(format!("{error:?}"), "working tree has uncommitted changes");
}

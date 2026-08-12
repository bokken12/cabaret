mod fixture;

use std::fs;

use fixture::{Fixture, diverged};

#[test]
fn merges_the_parent_into_the_change() {
    let fixture = diverged(
        &[("mine.txt", "original\n"), ("theirs.txt", "original\n")],
        &[("mine.txt", "child edit\n"), ("theirs.txt", "original\n")],
        &[("mine.txt", "original\n"), ("theirs.txt", "main edit\n")],
    );
    let (old_child_tip, _) = fixture.tip("child");
    let (main_tip, _) = fixture.tip("main");

    let conflicts = fixture.merge("main").unwrap().expect("expected a merge");

    assert_eq!(conflicts, Vec::<String>::new());
    assert_eq!(fixture.tip("child").1, vec![old_child_tip, main_tip]);
    assert_eq!(fixture.worktree_file("mine.txt"), "child edit\n");
    assert_eq!(fixture.worktree_file("theirs.txt"), "main edit\n");
    assert!(!fixture.repo().is_dirty().unwrap());
}

#[test]
fn commits_conflicts_with_markers() {
    let fixture = diverged(&[("greeting.txt", "hello\n")], &[("greeting.txt", "hi\n")], &[("greeting.txt", "hey\n")]);

    let conflicts = fixture.merge("main").unwrap().expect("expected a merge");

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

    let conflicts = fixture.merge("main").unwrap().expect("expected a merge");

    assert_eq!(conflicts, Vec::<String>::new());
    assert_eq!(fixture.worktree_file("new/nested/file.txt"), "new\n");
    assert!(!fixture.repo().workdir().unwrap().join("old").exists());
    assert_eq!(fixture.worktree_file("mine.txt"), "mine\n");
    assert!(!fixture.repo().is_dirty().unwrap());
}

#[test]
fn a_second_merge_is_up_to_date() {
    let fixture = diverged(&[("file.txt", "original\n")], &[("file.txt", "child\n")], &[("other.txt", "main\n")]);

    assert!(fixture.merge("main").unwrap().is_some());
    let tip = fixture.tip("child");

    assert!(fixture.merge("main").unwrap().is_none());
    assert_eq!(fixture.tip("child"), tip);
}

#[test]
fn merges_from_the_named_change() {
    let fixture = Fixture::new();
    let root = fixture.commit("refs/heads/main", &[("file.txt", "original\n")], &[]);
    fixture.commit("refs/heads/child", &[("file.txt", "original\n")], &[root]);
    fixture.commit("refs/heads/main", &[("file.txt", "original\n"), ("main.txt", "main\n")], &[root]);
    fixture.commit("refs/heads/other", &[("file.txt", "original\n"), ("other.txt", "other\n")], &[root]);
    fixture.checkout("child", &[("file.txt", "original\n")]);

    let conflicts = fixture.merge("other").unwrap().expect("expected a merge");
    assert_eq!(conflicts, Vec::<String>::new());
    assert_eq!(fixture.worktree_file("other.txt"), "other\n");
    assert!(!fixture.repo().workdir().unwrap().join("main.txt").exists());
}

#[test]
fn a_change_checked_out_in_another_workspace_refuses_to_merge() {
    let fixture = diverged(&[("file.txt", "original\n")], &[("file.txt", "child\n")], &[("file.txt", "main\n")]);
    fixture.checkout("main", &[("file.txt", "main\n")]);
    let (_dir, workspace) = fixture.add_workspace("wt", "child");

    let error = fixture.merge("main").unwrap_err();
    assert_eq!(
        format!("{error:?}"),
        format!("child is checked out in workspace {}; rerun from that workspace", workspace.display())
    );
}

#[test]
fn a_dirty_worktree_refuses_to_merge() {
    let fixture = diverged(&[("file.txt", "original\n")], &[("file.txt", "child\n")], &[("other.txt", "main\n")]);
    fs::write(fixture.repo().workdir().unwrap().join("file.txt"), "uncommitted\n").unwrap();

    let error = fixture.merge("main").unwrap_err();
    assert_eq!(format!("{error:?}"), "working tree has uncommitted changes");
}

#[test]
fn a_dirty_source_workspace_refuses_to_merge() {
    let fixture = diverged(&[("file.txt", "original\n")], &[("file.txt", "child\n")], &[("other.txt", "main\n")]);
    fs::write(fixture.repo().workdir().unwrap().join("file.txt"), "uncommitted\n").unwrap();

    let error = format!("{:?}", fixture.prepare("main", "child").unwrap_err());
    assert!(error.starts_with("child has uncommitted changes in workspace "), "{error}");
}

#[test]
fn a_dropped_merge_commits_nothing() {
    let fixture = diverged(&[("greeting.txt", "hello\n")], &[("greeting.txt", "hi\n")], &[("greeting.txt", "hey\n")]);
    let main = fixture.tip("main");
    let child = fixture.tip("child");

    let merge = fixture.prepare("main", "child").unwrap().expect("expected a merge");
    assert_eq!(merge.conflicts(), ["greeting.txt"]);
    drop(merge);

    assert_eq!(fixture.tip("main"), main);
    assert_eq!(fixture.tip("child"), child);
    assert_eq!(fixture.worktree_file("greeting.txt"), "hi\n");
}

#[test]
fn merges_into_a_branch_that_is_not_checked_out() {
    let fixture = diverged(
        &[("mine.txt", "original\n"), ("theirs.txt", "original\n")],
        &[("mine.txt", "child edit\n"), ("theirs.txt", "original\n")],
        &[("mine.txt", "original\n"), ("theirs.txt", "main edit\n")],
    );
    let (child_tip, _) = fixture.tip("child");
    let (old_main_tip, _) = fixture.tip("main");

    let merge = fixture.prepare("main", "child").unwrap().expect("expected a merge");
    assert!(merge.conflicts().is_empty());
    fixture.cabaret.commit_merge(merge, "land child".into()).unwrap();

    assert_eq!(fixture.tip("main").1, vec![old_main_tip, child_tip]);
    assert_eq!(fixture.tip("child").0, child_tip);
    assert_eq!(fixture.worktree_file("mine.txt"), "child edit\n");
    assert!(!fixture.repo().is_dirty().unwrap());
    assert!(fixture.prepare("main", "child").unwrap().is_none());
}

#[test]
fn merging_into_the_checked_out_branch_updates_its_worktree() {
    let fixture = diverged(
        &[("mine.txt", "original\n")],
        &[("mine.txt", "child edit\n")],
        &[("mine.txt", "original\n"), ("theirs.txt", "main edit\n")],
    );
    fixture.checkout("main", &[("mine.txt", "original\n"), ("theirs.txt", "main edit\n")]);

    let merge = fixture.prepare("main", "child").unwrap().expect("expected a merge");
    fixture.cabaret.commit_merge(merge, "land child".into()).unwrap();

    assert_eq!(fixture.worktree_file("mine.txt"), "child edit\n");
    assert_eq!(fixture.worktree_file("theirs.txt"), "main edit\n");
    assert!(!fixture.repo().is_dirty().unwrap());
}

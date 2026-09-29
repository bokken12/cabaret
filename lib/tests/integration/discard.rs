//! Discarding: what a change's workspace has on disk goes back to the change's tip.

use cabaret_lib::{Pathspec, safeguard::CommitAllow};
use expect_test::expect;

use super::{
    fixture::{Fixture, id, worktree},
    workspace::two_changes,
};

/// The outcome of discarding, then what is left uncommitted.
fn discard(fixture: &Fixture, change: &str, pathspecs: &[&str]) -> String {
    let pathspecs: Vec<Pathspec> = pathspecs.iter().map(|spec| spec.parse().unwrap()).collect();
    match fixture.cabaret.discard(&id(change), &pathspecs) {
        Ok(()) => format!("uncommitted {:?}", fixture.cabaret.workspace_files(&id(change), &[]).unwrap()),
        Err(error) => format!("error: {error:?}"),
    }
}

#[test]
fn edits_additions_and_deletions_are_undone() {
    let fixture = two_changes();
    let tip = fixture.tip("one");
    fixture.write("one.txt", "one, edited\n");
    fixture.write("added.txt", "added\n");
    fixture.delete("main.txt");
    expect!["uncommitted []"].assert_eq(&discard(&fixture, "one", &[]));
    expect![[r#"
        clean
        main.txt "main\n"
        one.txt "one\n"
    "#]]
    .assert_eq(&fixture.worktree());
    assert_eq!(fixture.tip("one"), tip);
}

#[test]
fn pathspecs_leave_other_files_uncommitted() {
    let fixture = two_changes();
    fixture.write("in.txt", "in\n");
    fixture.write("out.txt", "out\n");
    fixture.write("one.txt", "one, edited\n");
    expect![[r#"uncommitted [Added { path: "out.txt" }]"#]].assert_eq(&discard(
        &fixture,
        "one",
        &["in.txt", "one.txt"],
    ));
    expect![[r#"
        clean
        main.txt "main\n"
        one.txt "one\n"
        out.txt "out\n"
    "#]]
    .assert_eq(&fixture.worktree());
}

#[test]
fn dot_discards_everything() {
    let fixture = two_changes();
    std::fs::create_dir(fixture.path("main/dir")).unwrap();
    fixture.write("dir/added.txt", "added\n");
    fixture.write("one.txt", "one, edited\n");
    expect!["uncommitted []"].assert_eq(&discard(&fixture, "one", &["."]));
    expect![[r#"
        clean
        main.txt "main\n"
        one.txt "one\n"
    "#]]
    .assert_eq(&fixture.worktree());
}

#[test]
fn rename_goes_back() {
    let fixture = two_changes();
    fixture.delete("one.txt");
    fixture.write("moved.txt", "one\n");
    expect!["uncommitted []"].assert_eq(&discard(&fixture, "one", &["one.txt", "moved.txt"]));
    expect![[r#"
        clean
        main.txt "main\n"
        one.txt "one\n"
    "#]]
    .assert_eq(&fixture.worktree());
}

#[test]
fn staged_file_is_unstaged_and_removed() {
    let fixture = two_changes();
    fixture.stage("staged.txt", "staged\n");
    expect!["uncommitted []"].assert_eq(&discard(&fixture, "one", &["staged.txt"]));
    expect![[r#"
        clean
        main.txt "main\n"
        one.txt "one\n"
    "#]]
    .assert_eq(&fixture.worktree());
}

#[test]
fn other_staged_files_stay_staged() {
    let fixture = two_changes();
    fixture.stage("staged.txt", "staged\n");
    fixture.write("one.txt", "one, edited\n");
    expect![[r#"uncommitted [Added { path: "staged.txt" }]"#]].assert_eq(&discard(&fixture, "one", &["one.txt"]));
    fixture.cabaret.commit(&id("one"), &[], CommitAllow::default()).unwrap();
    expect![[r#"
        clean
        main.txt "main\n"
        one.txt "one\n"
        staged.txt "staged\n"
    "#]]
    .assert_eq(&fixture.worktree());
}

#[test]
fn ignored_files_are_left_alone() {
    let fixture = two_changes();
    fixture.write(".gitignore", "ignored.txt\n");
    fixture.cabaret.commit(&id("one"), &[], CommitAllow::default()).unwrap();
    fixture.write("ignored.txt", "ignored\n");
    expect!["uncommitted []"].assert_eq(&discard(&fixture, "one", &[]));
    assert!(fixture.exists("ignored.txt"));
}

#[test]
fn linked_workspace_discards_its_own_files() {
    let fixture = two_changes();
    let two = fixture.add_workspace("two");
    std::fs::write(two.workdir().unwrap().join("two.txt"), "two, edited\n").unwrap();
    fixture.write("one.txt", "one, edited\n");
    expect!["uncommitted []"].assert_eq(&discard(&fixture, "two", &[]));
    expect![[r#"
        clean
        main.txt "main\n"
        two.txt "two\n"
    "#]]
    .assert_eq(&worktree(&two));
    expect![[r#"
        dirty
        main.txt "main\n"
        one.txt "one, edited\n"
    "#]]
    .assert_eq(&fixture.worktree());
}

#[test]
fn change_without_workspace_refuses() {
    let fixture = two_changes();
    expect!["error: two is not checked out in any workspace"].assert_eq(&discard(&fixture, "two", &[]));
}

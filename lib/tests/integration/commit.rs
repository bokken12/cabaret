//! Committing: what a change's workspace has on disk becomes the change's new tip.

use expect_test::expect;

use super::fixture::{Fixture, alice, id, worktree};

/// `one` and `two` on `main`, each adding a file of its own; `one` is checked out.
fn two_changes() -> Fixture {
    let fixture = Fixture::new();
    fixture.root("main", &[("main.txt", "main\n")]);
    fixture.create("one", "main", &alice());
    fixture.commit("one", &[("one.txt", "one\n")]);
    fixture.create("two", "main", &alice());
    fixture.commit("two", &[("two.txt", "two\n")]);
    fixture.checkout("one");
    fixture
}

fn commit(fixture: &Fixture, change: &str, pathspecs: &[&str]) -> String {
    let pathspecs = pathspecs.iter().map(|spec| spec.parse().unwrap()).collect::<Vec<_>>();
    match fixture.cabaret.commit(&id(change), &pathspecs) {
        Ok(revision) => format!("committed {:?}", fixture.message(revision)),
        Err(error) => format!("error: {error:?}"),
    }
}

#[test]
fn edits_additions_and_deletions_become_tip() {
    let fixture = two_changes();
    let before = fixture.tip("one");
    fixture.write("one.txt", "one, edited\n");
    fixture.write("added.txt", "added\n");
    fixture.delete("main.txt");
    expect![[r#"committed "one""#]].assert_eq(&commit(&fixture, "one", &[]));
    expect![[r"
        one
          workspace main
          parents main
          owners alice@example.com
          base main
          diff +added.txt -main.txt +one.txt
    "]]
    .assert_eq(&fixture.describe("one"));
    expect![[r#"
        clean
        added.txt "added\n"
        one.txt "one, edited\n"
    "#]]
    .assert_eq(&fixture.worktree());
    assert_eq!(fixture.parents(fixture.tip("one")), vec![before]);
}

#[test]
fn pathspecs_leave_other_files_uncommitted() {
    let fixture = two_changes();
    fixture.write("in.txt", "in\n");
    fixture.write("out.txt", "out\n");
    fixture.write("one.txt", "one, edited\n");
    expect![[r#"committed "one""#]].assert_eq(&commit(&fixture, "one", &["in.txt"]));
    expect![[r"
        one
          workspace main
          parents main
          owners alice@example.com
          base main
          diff +in.txt +one.txt
    "]]
    .assert_eq(&fixture.describe("one"));
    expect![[r#"
        dirty
        in.txt "in\n"
        main.txt "main\n"
        one.txt "one, edited\n"
        out.txt "out\n"
    "#]]
    .assert_eq(&fixture.worktree());
    assert_eq!(fixture.cabaret.blob(fixture.tip("one"), &"one.txt".parse().unwrap()).unwrap().unwrap(), "one\n");
}

#[test]
fn staged_files_are_committed() {
    let fixture = two_changes();
    fixture.stage("staged.txt", "staged\n");
    expect![[r#"committed "one""#]].assert_eq(&commit(&fixture, "one", &[]));
    expect![[r"
        one
          workspace main
          parents main
          owners alice@example.com
          base main
          diff +one.txt +staged.txt
    "]]
    .assert_eq(&fixture.describe("one"));
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
    fixture.write("ignored.txt", "ignored\n");
    expect![[r#"committed "one""#]].assert_eq(&commit(&fixture, "one", &[]));
    expect![[r"
        one
          workspace main
          parents main
          owners alice@example.com
          base main
          diff +.gitignore +one.txt
    "]]
    .assert_eq(&fixture.describe("one"));
    assert!(fixture.exists("ignored.txt"));
}

#[test]
fn linked_workspace_commits_its_own_files() {
    let fixture = two_changes();
    let two = fixture.add_workspace("two");
    std::fs::write(two.workdir().unwrap().join("two.txt"), "two, edited\n").unwrap();
    fixture.write("one.txt", "one, edited\n");
    expect![[r#"committed "two""#]].assert_eq(&commit(&fixture, "two", &[]));
    expect![[r#"
        clean
        main.txt "main\n"
        two.txt "two, edited\n"
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
fn nothing_to_commit_refuses() {
    let fixture = two_changes();
    let tip = fixture.tip("one");
    expect!["error: one has nothing to commit"].assert_eq(&commit(&fixture, "one", &[]));
    assert_eq!(fixture.tip("one"), tip);
}

#[test]
fn archived_change_refuses() {
    let fixture = two_changes();
    fixture.cabaret.archive(&id("one")).unwrap();
    fixture.write("one.txt", "one, edited\n");
    let tip = fixture.tip("one");
    expect!["error: one is archived"].assert_eq(&commit(&fixture, "one", &[]));
    assert_eq!(fixture.tip("one"), tip);
}

#[test]
fn change_without_workspace_refuses() {
    let fixture = two_changes();
    expect!["error: two is not checked out in any workspace"].assert_eq(&commit(&fixture, "two", &[]));
}

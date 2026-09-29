//! Rebasing: each parent's tip is merged into the change, and the workspace holding the change
//! follows its branch, keeping its local changes.

use cabaret_lib::{
    Error,
    safeguard::{Allow, SafeguardKind},
};
use expect_test::expect;

use super::fixture::{Fixture, alice, bob, id, worktree};

/// `child` and its parent `main` have each committed since `child` forked.
fn diverged() -> Fixture {
    let fixture = Fixture::new();
    fixture.root("main", &[("shared.txt", "shared\n")]);
    fixture.create("child", "main", &alice());
    fixture.commit("child", &[("child.txt", "child\n")]);
    fixture.commit("main", &[("main.txt", "main\n")]);
    fixture
}

fn rebase(fixture: &Fixture, change: &str, onto: Option<&str>) -> String {
    rebase_allowing(fixture, change, onto, &Allow::default())
}

fn rebase_allowing(fixture: &Fixture, change: &str, onto: Option<&str>, allow: &Allow) -> String {
    let onto = onto.map(id);
    match fixture.cabaret.rebase(&id(change), onto.as_deref(), allow) {
        Ok(rebase) => format!("{rebase:?}"),
        Err(Error::Refused(refused)) => {
            let shown: Vec<String> = refused.iter().map(ToString::to_string).collect();
            format!("refused: {}", shown.join("; "))
        }
        Err(error) => format!("error: {error:?}"),
    }
}

#[test]
fn parent_merged_into_change() {
    let fixture = diverged();
    fixture.checkout("child");
    expect![[r#"Rebase { merged: {"main"}, conflicts: {}, remaining: {} }"#]]
        .assert_eq(&rebase(&fixture, "child", None));
    expect![[r"
        child
          workspace main
          parents main
          owners alice@example.com
          title child
          base main
          diff +child.txt
    "]]
    .assert_eq(&fixture.describe("child"));
    expect![[r#"
        clean
        child.txt "child\n"
        main.txt "main\n"
        shared.txt "shared\n"
    "#]]
    .assert_eq(&fixture.worktree());
    let tip = fixture.tip("child");
    expect!["Rebase { merged: {}, conflicts: {}, remaining: {} }"].assert_eq(&rebase(&fixture, "child", None));
    assert_eq!(fixture.tip("child"), tip);
}

#[test]
fn conflicts_committed_with_markers() {
    let fixture = Fixture::new();
    fixture.root("main", &[("greeting.txt", "hello\n")]);
    fixture.create("child", "main", &alice());
    fixture.commit("child", &[("greeting.txt", "hi\n")]);
    fixture.commit("main", &[("greeting.txt", "hey\n")]);
    fixture.checkout("child");
    expect![[r#"Rebase { merged: {"main"}, conflicts: {"greeting.txt"}, remaining: {} }"#]]
        .assert_eq(&rebase(&fixture, "child", None));
    expect![[r#"
        clean
        greeting.txt "<<<<<<< child\nhi\n||||||| base\nhello\n=======\nhey\n>>>>>>> main\n"
    "#]]
    .assert_eq(&fixture.worktree());
}

#[test]
fn conflict_keeps_lines_common_to_both_sides_within_markers() {
    let fixture = Fixture::new();
    fixture.root("main", &[("file.txt", "one\ntwo\nthree\n")]);
    fixture.create("child", "main", &alice());
    fixture.commit("child", &[("file.txt", "one\nsame\nchild\nthree\n")]);
    fixture.commit("main", &[("file.txt", "one\nsame\nmain\nthree\n")]);
    rebase(&fixture, "child", None);
    expect![[r#"
        one
        <<<<<<< child
        same
        child
        ||||||| base
        two
        =======
        same
        main
        >>>>>>> main
        three
    "#]]
    .assert_eq(&fixture.text(fixture.tip("child"), "file.txt").unwrap());
}

#[test]
fn change_without_commits_fast_forwards() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("empty", "main", &alice());
    fixture.commit("main", &[("main.txt", "main\n")]);
    expect![[r#"Rebase { merged: {"main"}, conflicts: {}, remaining: {} }"#]]
        .assert_eq(&rebase(&fixture, "empty", None));
    assert_eq!(fixture.tip("empty"), fixture.tip("main"));
}

#[test]
fn onto_merges_only_that_parent() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("left", "main", &alice());
    fixture.create("right", "main", &alice());
    fixture.commit("right", &[("right.txt", "right\n")]);
    fixture.create("join", "left", &alice());
    fixture.cabaret.add_parent(&id("join"), &id("right"), &Allow::default()).unwrap();
    fixture.commit("left", &[("left.txt", "left\n")]);
    expect![[r#"Rebase { merged: {"right"}, conflicts: {}, remaining: {} }"#]].assert_eq(&rebase(
        &fixture,
        "join",
        Some("right"),
    ));
    expect![[r#"Rebase { merged: {"left"}, conflicts: {}, remaining: {} }"#]]
        .assert_eq(&rebase(&fixture, "join", None));
}

#[test]
fn conflict_stops_before_next_parent() {
    let fixture = Fixture::new();
    fixture.root("main", &[("file.txt", "original\n")]);
    fixture.create("left", "main", &alice());
    fixture.create("right", "main", &alice());
    fixture.create("join", "left", &alice());
    fixture.cabaret.add_parent(&id("join"), &id("right"), &Allow::default()).unwrap();
    fixture.commit("join", &[("file.txt", "join\n")]);
    fixture.commit("left", &[("file.txt", "left\n")]);
    fixture.commit("right", &[("right.txt", "right\n")]);
    expect![[r#"Rebase { merged: {"left"}, conflicts: {"file.txt"}, remaining: {"right"} }"#]]
        .assert_eq(&rebase(&fixture, "join", None));
    fixture.commit("join", &[("file.txt", "resolved\n")]);
    expect![[r#"Rebase { merged: {"right"}, conflicts: {}, remaining: {} }"#]]
        .assert_eq(&rebase(&fixture, "join", None));
}

#[test]
fn onto_must_be_a_parent() {
    let fixture = diverged();
    fixture.create("other", "main", &alice());
    expect!["error: other is not a parent of child"].assert_eq(&rebase(&fixture, "child", Some("other")));
}

#[test]
fn workspace_keeps_local_changes() {
    let fixture = diverged();
    fixture.checkout("child");
    fixture.write("child.txt", "uncommitted\n");
    expect![[r#"Rebase { merged: {"main"}, conflicts: {}, remaining: {} }"#]]
        .assert_eq(&rebase(&fixture, "child", None));
    expect![[r#"
        dirty
        child.txt "uncommitted\n"
        main.txt "main\n"
        shared.txt "shared\n"
    "#]]
    .assert_eq(&fixture.worktree());
}

#[test]
fn local_changes_conflicting_with_parent_get_markers() {
    let fixture = diverged();
    fixture.checkout("child");
    fixture.commit("main", &[("shared.txt", "from main\n")]);
    fixture.write("shared.txt", "from child\n");
    expect![[r#"Rebase { merged: {"main"}, conflicts: {}, remaining: {} }"#]]
        .assert_eq(&rebase(&fixture, "child", None));
    expect![[r#"
        dirty
        child.txt "child\n"
        main.txt "main\n"
        shared.txt "<<<<<<< local\nfrom child\n||||||| base\nshared\n=======\nfrom main\n>>>>>>> child\n"
    "#]]
    .assert_eq(&fixture.worktree());
}

#[test]
fn staged_changes_stay_on_disk() {
    let fixture = diverged();
    fixture.checkout("child");
    fixture.stage("child.txt", "staged\n");
    expect![[r#"Rebase { merged: {"main"}, conflicts: {}, remaining: {} }"#]]
        .assert_eq(&rebase(&fixture, "child", None));
    expect![[r#"
        dirty
        child.txt "staged\n"
        main.txt "main\n"
        shared.txt "shared\n"
    "#]]
    .assert_eq(&fixture.worktree());
}

#[test]
fn untracked_file_parent_adds_gets_markers() {
    let fixture = diverged();
    fixture.checkout("child");
    fixture.write("main.txt", "untracked\n");
    expect![[r#"Rebase { merged: {"main"}, conflicts: {}, remaining: {} }"#]]
        .assert_eq(&rebase(&fixture, "child", None));
    expect![[r#"
        dirty
        child.txt "child\n"
        main.txt "<<<<<<< local\nuntracked\n||||||| base\n=======\nmain\n>>>>>>> child\n"
        shared.txt "shared\n"
    "#]]
    .assert_eq(&fixture.worktree());
}

#[test]
fn linked_workspace_follows_change() {
    let fixture = diverged();
    fixture.checkout("main");
    let linked = fixture.add_workspace("child");
    expect![[r#"Rebase { merged: {"main"}, conflicts: {}, remaining: {} }"#]]
        .assert_eq(&rebase(&fixture, "child", None));
    expect![[r#"
        clean
        child.txt "child\n"
        main.txt "main\n"
        shared.txt "shared\n"
    "#]]
    .assert_eq(&worktree(&linked));
}

#[test]
fn non_owner_refuses_unless_allowed() {
    let fixture = diverged();
    fixture.cabaret.set_owners(&id("child"), [bob()].into(), &Allow::default()).unwrap();
    let tip = fixture.tip("child");
    expect!["refused: you (alice@example.com) are not an owner (owners: bob@example.com)"]
        .assert_eq(&rebase(&fixture, "child", None));
    assert_eq!(fixture.tip("child"), tip);
    expect![[r#"Rebase { merged: {"main"}, conflicts: {}, remaining: {} }"#]].assert_eq(&rebase_allowing(
        &fixture,
        "child",
        None,
        &Allow::from_iter([SafeguardKind::NonOwner]),
    ));
}

#[test]
fn errors_come_before_safeguards() {
    let fixture = diverged();
    fixture.cabaret.set_owners(&id("child"), [bob()].into(), &Allow::default()).unwrap();
    expect!["error: child is not a parent of child"].assert_eq(&rebase(&fixture, "child", Some("child")));
}

/// `child` has rebased onto `main` into a conflict, and `main` has moved on since.
fn conflicted() -> Fixture {
    let fixture = Fixture::new();
    fixture.root("main", &[("greeting.txt", "hello\n")]);
    fixture.create("child", "main", &alice());
    fixture.commit("child", &[("greeting.txt", "hi\n")]);
    fixture.commit("main", &[("greeting.txt", "hey\n")]);
    rebase(&fixture, "child", None);
    fixture.commit("main", &[("main.txt", "main\n")]);
    fixture
}

#[test]
fn conflicted_refuses_unless_allowed() {
    let fixture = conflicted();
    expect!["refused: conflicts in greeting.txt"].assert_eq(&rebase(&fixture, "child", None));
    let allow = Allow::from_iter([SafeguardKind::Conflicted]);
    expect![[r#"Rebase { merged: {"main"}, conflicts: {}, remaining: {} }"#]]
        .assert_eq(&rebase_allowing(&fixture, "child", None, &allow));
}

#[test]
fn conflicted_parent_refuses_unless_allowed() {
    let fixture = conflicted();
    fixture.create("grandchild", "child", &alice());
    fixture.commit("grandchild", &[("grandchild.txt", "grandchild\n")]);
    fixture.commit("child", &[("child.txt", "child\n")]);
    expect!["refused: child has conflicts in greeting.txt"].assert_eq(&rebase(&fixture, "grandchild", None));
    let allow = Allow::from_iter([SafeguardKind::ParentConflicted]);
    expect![[r#"Rebase { merged: {"child"}, conflicts: {}, remaining: {} }"#]].assert_eq(&rebase_allowing(
        &fixture,
        "grandchild",
        None,
        &allow,
    ));
}

#[test]
fn merged_parent_brings_no_conflicts() {
    let fixture = conflicted();
    fixture.create("grandchild", "child", &alice());
    fixture.commit("grandchild", &[("grandchild.txt", "grandchild\n")]);
    let concerns = fixture.cabaret.rebase_safeguards(&id("grandchild"), None).unwrap();
    expect!["[]"].assert_eq(&format!("{concerns:?}"));
}

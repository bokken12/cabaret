//! Rebasing: each parent's tip is merged into the change, and a workspace holding the change
//! follows its branch.

use expect_test::expect;

use super::fixture::{Fixture, alice, id, worktree};

/// `child` and its parent `main` have each committed since `child` forked.
fn diverged() -> Fixture {
    let fixture = Fixture::new();
    fixture.root("main", &[("shared.txt", "shared\n")]);
    fixture.create("child", "main", &alice());
    fixture.commit("child", &[("child.txt", "child\n")]);
    fixture.commit("main", &[("main.txt", "main\n")]);
    fixture
}

/// [`Fixture::show`] without the tip hash, which a merge commit stamps with the current time.
fn show(fixture: &Fixture, change: &str) -> String {
    let shown = fixture.show(change);
    let (first, rest) = shown.split_once('\n').unwrap();
    format!("{}\n{rest}", first.split_once(' ').unwrap().0)
}

fn rebase(fixture: &Fixture, change: &str, onto: Option<&str>) -> String {
    let onto = onto.map(id);
    match fixture.cabaret.rebase(&id(change), onto.as_deref()) {
        Ok(rebase) => format!("{rebase:?}"),
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
          base main
          diff +child.txt
    "]]
    .assert_eq(&show(&fixture, "child"));
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
    fixture.cabaret.add_parent(&id("join"), &id("right")).unwrap();
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
    fixture.cabaret.add_parent(&id("join"), &id("right")).unwrap();
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
fn dirty_workspace_refuses() {
    let fixture = diverged();
    fixture.checkout("child");
    fixture.write("child.txt", "uncommitted\n");
    let tip = fixture.tip("child");
    expect!["error: workspace main has uncommitted changes"].assert_eq(&rebase(&fixture, "child", None));
    assert_eq!(fixture.tip("child"), tip);
}

#[test]
fn linked_workspace_follows_change() {
    let fixture = diverged();
    fixture.checkout("main");
    let (_dir, linked) = fixture.link_workspace("child");
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

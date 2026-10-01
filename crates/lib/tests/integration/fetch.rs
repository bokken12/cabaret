//! Fetching: exchanging logs with origin both ways, merging writes that did not see each other,
//! and fast-forwarding the branches of origin's default branch and of open changes either way.

use expect_test::expect;

use super::fixture::{Fixture, alice, bob, carol, id};

/// A bare origin holding `child` on `main`, and a repository on it that has fetched once, as bob.
fn fetched() -> (Fixture, Fixture) {
    let origin = Fixture::bare();
    origin.root("main", &[("greeting.txt", "hello\n")]);
    origin.create("child", "main", &alice());
    let clone = Fixture::with_origin(&origin);
    assert!(clone.cabaret.fetch().unwrap().is_empty());
    (origin, clone)
}

#[test]
fn takes_origin_logs_and_branches() {
    let (origin, clone) = fetched();
    assert_eq!(clone.log_head("child"), origin.log_head("child"));
    expect![[r#"
        child
          parents main
          owners alice@example.com
          title child
          base main
          diff (empty)
    "#]]
    .assert_eq(&clone.describe("child"));
}

#[test]
fn pushes_local_logs() {
    let (origin, clone) = fetched();
    clone.create("local", "main", &bob());
    clone.cabaret.set_title(&id("child"), Some("Retitled".into())).unwrap();
    clone.cabaret.fetch().unwrap();
    assert_eq!(origin.log_head("local"), clone.log_head("local"));
    assert_eq!(origin.log_head("child"), clone.log_head("child"));
    expect![[r#"
        child
          parents main
          owners alice@example.com
          title Retitled
          base main
          diff (empty)
    "#]]
    .assert_eq(&origin.describe("child"));
}

#[test]
fn writes_that_did_not_see_each_other_merge() {
    let (origin, clone) = fetched();
    origin.cabaret.add_owner(&id("child"), &carol()).unwrap();
    origin.cabaret.set_description(&id("child"), Some("Described at origin.".into())).unwrap();
    clone.cabaret.set_title(&id("child"), Some("Retitled".into())).unwrap();
    clone.cabaret.fetch().unwrap();
    assert_eq!(origin.log_head("child"), clone.log_head("child"));
    expect![[r#"
        child
          parents main
          owners alice@example.com carol@example.com
          title Retitled
          description Described at origin.
          base main
          diff (empty)
    "#]]
    .assert_eq(&origin.describe("child"));
    expect![[r#"
        message "merge\n"
        actions.jsonl ""
        description.md "Described at origin."
    "#]]
    .assert_eq(&clone.metadata("child"));
}

#[test]
fn conflicting_descriptions_keep_both() {
    let (origin, clone) = fetched();
    origin.cabaret.set_description(&id("child"), Some("Described at origin.\n".into())).unwrap();
    clone.cabaret.set_description(&id("child"), Some("Described by bob.\n".into())).unwrap();
    clone.cabaret.fetch().unwrap();
    expect![[r#"
        <<<<<<< bob@example.com
        Described by bob.
        ||||||| base
        =======
        Described at origin.
        >>>>>>> alice@example.com
    "#]]
    .assert_eq(&clone.snapshot("child").description.unwrap());
}

#[test]
fn fetching_again_changes_nothing() {
    let (origin, clone) = fetched();
    origin.cabaret.add_owner(&id("child"), &carol()).unwrap();
    clone.cabaret.set_title(&id("child"), Some("Retitled".into())).unwrap();
    clone.cabaret.fetch().unwrap();
    let merged = clone.log_head("child");
    clone.cabaret.fetch().unwrap();
    assert_eq!(clone.log_head("child"), merged);
    assert_eq!(origin.log_head("child"), merged);
}

#[test]
fn fast_forwards_branches_behind_origin() {
    let (origin, clone) = fetched();
    origin.commit("main", &[("main.txt", "main\n")]);
    origin.commit("child", &[("child.txt", "child\n")]);
    assert!(clone.cabaret.fetch().unwrap().is_empty());
    assert_eq!(clone.tip("main"), origin.tip("main"));
    assert_eq!(clone.tip("child"), origin.tip("child"));
}

#[test]
fn pushes_branches_ahead_of_origin() {
    let (origin, clone) = fetched();
    clone.commit("main", &[("main.txt", "main\n")]);
    clone.commit("child", &[("child.txt", "child\n")]);
    clone.create("local", "main", &bob());
    assert!(clone.cabaret.fetch().unwrap().is_empty());
    assert_eq!(origin.tip("main"), clone.tip("main"));
    assert_eq!(origin.tip("child"), clone.tip("child"));
    assert_eq!(origin.tip("local"), clone.tip("local"));
}

#[test]
fn leaves_diverged_branches() {
    let (origin, clone) = fetched();
    let theirs = origin.commit("child", &[("child.txt", "alice\n")]);
    let ours = clone.commit("child", &[("child.txt", "bob\n")]);
    let kept = clone.cabaret.fetch().unwrap();
    expect![[r#"{"child": "diverged from origin"}"#]].assert_eq(&format!("{kept:?}"));
    assert_eq!(origin.tip("child"), theirs);
    assert_eq!(clone.tip("child"), ours);
}

#[test]
fn leaves_plain_branches() {
    let (origin, clone) = fetched();
    origin.branch("theirs", "main");
    clone.branch("ours", "main");
    clone.cabaret.fetch().unwrap();
    assert!(!clone.cabaret.changes().unwrap().contains(&id("theirs")));
    assert!(!origin.cabaret.changes().unwrap().contains(&id("ours")));
}

#[test]
fn leaves_archived_branches() {
    let (origin, clone) = fetched();
    let before = origin.tip("child");
    clone.commit("child", &[("child.txt", "child\n")]);
    clone.archive("child");
    clone.cabaret.fetch().unwrap();
    assert!(origin.snapshot("child").archived);
    assert_eq!(origin.tip("child"), before);
}

#[test]
fn carries_local_changes_into_fast_forward() {
    let (origin, clone) = fetched();
    clone.checkout("child");
    clone.write("greeting.txt", "hello, bob\n");
    origin.commit("child", &[("child.txt", "child\n")]);
    assert!(clone.cabaret.fetch().unwrap().is_empty());
    assert_eq!(clone.tip("child"), origin.tip("child"));
    expect![[r#"
        dirty
        child.txt "child\n"
        greeting.txt "hello, bob\n"
    "#]]
    .assert_eq(&clone.worktree());
}

#[test]
fn leaves_branches_whose_local_changes_conflict() {
    let (origin, clone) = fetched();
    clone.checkout("child");
    clone.write("greeting.txt", "hello, bob\n");
    let before = clone.tip("child");
    origin.commit("child", &[("greeting.txt", "hello, alice\n")]);
    let kept = clone.cabaret.fetch().unwrap();
    expect![[r#"{"child": "local changes in workspace main conflict with origin's"}"#]].assert_eq(&format!("{kept:?}"));
    assert_eq!(clone.tip("child"), before);
    expect![[r#"
        dirty
        greeting.txt "hello, bob\n"
    "#]]
    .assert_eq(&clone.worktree());
}

#[test]
fn needs_origin() {
    let fixture = Fixture::new();
    expect![[r#"The remote named "origin" did not exist"#]]
        .assert_eq(&format!("{:?}", fixture.cabaret.fetch().unwrap_err()));
}

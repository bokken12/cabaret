//! Fetching: exchanging logs with origin both ways, merging writes that did not see each other.

use expect_test::expect;

use super::fixture::{Fixture, alice, bob, carol, id};

/// An origin holding `child` on `main`, and a repository on it that has fetched once and tracks
/// both, as bob.
fn fetched() -> (Fixture, Fixture) {
    let origin = Fixture::new();
    origin.root("main", &[("greeting.txt", "hello\n")]);
    origin.create("child", "main", &alice());
    let clone = Fixture::with_origin(&origin);
    clone.cabaret.fetch().unwrap();
    clone.track("main");
    clone.track("child");
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
fn needs_origin() {
    let fixture = Fixture::new();
    expect![[r#"The remote named "origin" did not exist"#]]
        .assert_eq(&format!("{:?}", fixture.cabaret.fetch().unwrap_err()));
}

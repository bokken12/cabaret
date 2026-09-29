//! Landing: the parent merges the change in and the change is archived.

use cabaret_lib::Reason;
use expect_test::expect;

use super::fixture::{Fixture, alice, bob, id};

/// `child` and its parent `main` have each committed since `child` forked, and its owner alice
/// has reviewed it.
fn diverged() -> Fixture {
    let fixture = Fixture::new();
    fixture.root("main", &[("shared.txt", "shared\n")]);
    fixture.create("child", "main", &alice());
    fixture.commit("child", &[("child.txt", "child\n")]);
    fixture.mark_all("child");
    fixture.commit("main", &[("main.txt", "main\n")]);
    fixture
}

fn land(fixture: &Fixture, change: &str) -> String { land_even_though(fixture, change, &[]) }

fn land_even_though(fixture: &Fixture, change: &str, even_though: &[Reason]) -> String {
    match fixture.cabaret.land(&id(change), even_though) {
        Ok(parent) => format!("landed into {parent}"),
        Err(error) => format!("error: {error:?}"),
    }
}

#[test]
fn change_merged_into_parent_and_archived() {
    let fixture = diverged();
    fixture.checkout("main");
    expect!["landed into main"].assert_eq(&land(&fixture, "child"));
    expect![[r"
        main
          workspace main
          base (none)
          diff +child.txt +main.txt +shared.txt
    "]]
    .assert_eq(&fixture.describe("main"));
    expect![[r"
        child
          parents main
          owners alice@example.com
          archived
          title child
          base e0d18e9e
          diff (empty)
    "]]
    .assert_eq(&fixture.describe("child"));
    expect![[r#"
        clean
        child.txt "child\n"
        main.txt "main\n"
        shared.txt "shared\n"
    "#]]
    .assert_eq(&fixture.worktree());
}

#[test]
fn parent_that_has_not_moved_fast_forwards() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("child", "main", &alice());
    fixture.commit("child", &[("child.txt", "child\n")]);
    fixture.mark_all("child");
    expect!["landed into main"].assert_eq(&land(&fixture, "child"));
    assert_eq!(fixture.tip("main"), fixture.tip("child"));
}

#[test]
fn conflicts_refuse() {
    let fixture = Fixture::new();
    fixture.root("main", &[("greeting.txt", "hello\n")]);
    fixture.create("child", "main", &alice());
    fixture.commit("child", &[("greeting.txt", "hi\n")]);
    fixture.commit("main", &[("greeting.txt", "hey\n")]);
    let tip = fixture.tip("main");
    expect!["error: child conflicts with main; rebase and resolve first"].assert_eq(&land(&fixture, "child"));
    assert_eq!(fixture.tip("main"), tip);
    assert!(!fixture.snapshot("child").archived);
}

#[test]
fn nothing_to_land_refuses() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("empty", "main", &alice());
    expect!["error: empty has nothing to land"].assert_eq(&land(&fixture, "empty"));
}

#[test]
fn permanent_change_stays_open() {
    let fixture = diverged();
    fixture.checkout("main");
    fixture.cabaret.set_permanent(&id("child"), true).unwrap();
    expect!["landed into main"].assert_eq(&land(&fixture, "child"));
    assert!(!fixture.snapshot("child").archived);
}

#[test]
fn unreviewed_refuses_unless_acknowledged() {
    let fixture = diverged();
    fixture.commit("child", &[("more.txt", "more\n")]);
    let tip = fixture.tip("main");
    expect!["error: landing child is discouraged: unreviewed: alice@example.com left to review"]
        .assert_eq(&land(&fixture, "child"));
    assert_eq!(fixture.tip("main"), tip);
    expect!["landed into main"].assert_eq(&land_even_though(&fixture, "child", &[Reason::Unreviewed]));
}

#[test]
fn each_reason_needs_acknowledging() {
    let fixture = diverged();
    fixture.cabaret.set_owners(&id("child"), [bob()].into()).unwrap();
    expect!["error: landing child is discouraged: not-owner: owned by bob@example.com; unreviewed: bob@example.com left to review"]
        .assert_eq(&land(&fixture, "child"));
    expect!["error: landing child is discouraged: not-owner: owned by bob@example.com"].assert_eq(&land_even_though(
        &fixture,
        "child",
        &[Reason::Unreviewed],
    ));
    expect!["landed into main"].assert_eq(&land_even_though(
        &fixture,
        "child",
        &[Reason::Unreviewed, Reason::NotOwner],
    ));
}

#[test]
fn hard_refusals_come_before_concerns() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("empty", "main", &bob());
    expect!["error: empty has nothing to land"].assert_eq(&land(&fixture, "empty"));
}

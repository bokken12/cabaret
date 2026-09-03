//! Landing: the parent merges the change in and the change is archived.

use expect_test::expect;

use super::fixture::{Fixture, alice, id};

/// `child` and its parent `main` have each committed since `child` forked.
fn diverged() -> Fixture {
    let fixture = Fixture::new();
    fixture.root("main", &[("shared.txt", "shared\n")]);
    fixture.create("child", "main", &alice());
    fixture.commit("child", &[("child.txt", "child\n")]);
    fixture.commit("main", &[("main.txt", "main\n")]);
    fixture
}

fn land(fixture: &Fixture, change: &str) -> String {
    match fixture.cabaret.land(&id(change)) {
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

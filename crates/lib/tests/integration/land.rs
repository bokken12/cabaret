//! Landing: the parent merges the change in and the change is archived.

use cabaret_lib::{
    Error,
    safeguard::{Allow, Safeguard, SafeguardKind},
};
use expect_test::expect;

use super::fixture::{Fixture, alice, bob, id};

fn shown(safeguards: impl IntoIterator<Item = Safeguard>) -> String {
    let shown: Vec<String> = safeguards.into_iter().map(|safeguard| safeguard.to_string()).collect();
    shown.join("; ")
}

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

fn land(fixture: &Fixture, change: &str) -> String { land_allowing(fixture, change, &Allow::default()) }

fn land_allowing(fixture: &Fixture, change: &str, allow: &Allow) -> String {
    match fixture.cabaret.land(&id(change), allow) {
        Ok(parent) => format!("landed into {parent}"),
        Err(Error::Refused(refused)) => format!("refused: {}", shown(refused)),
        Err(error) => format!("error: {error:?}"),
    }
}

#[test]
fn change_merged_into_parent_and_archived() {
    let fixture = diverged();
    fixture.checkout("main");
    expect!["landed into main"].assert_eq(&land(&fixture, "child"));
    expect![[r#"
        main
          workspace main
          base (none)
          diff +child.txt +main.txt +shared.txt
    "#]]
    .assert_eq(&fixture.describe("main"));
    expect![[r#"
        child
          parents main
          owners alice@example.com
          archived
          title child
          base e0d18e9e
          diff (empty)
    "#]]
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
fn conflicts_into_root_refuse() {
    let fixture = Fixture::new();
    fixture.root("main", &[("greeting.txt", "hello\n")]);
    fixture.create("child", "main", &alice());
    fixture.commit("child", &[("greeting.txt", "hi\n")]);
    fixture.commit("main", &[("greeting.txt", "hey\n")]);
    let tip = fixture.tip("main");
    let allow = Allow::from_iter([SafeguardKind::Conflicted, SafeguardKind::Unreviewed]);
    expect!["error: child would land conflicts in main, a root; rebase and resolve first"]
        .assert_eq(&land_allowing(&fixture, "child", &allow));
    assert_eq!(fixture.tip("main"), tip);
    assert!(!fixture.snapshot("child").archived);
}

/// `child` conflicts with its parent `mid`, which sits on `main`.
fn conflicting() -> Fixture {
    let fixture = Fixture::new();
    fixture.root("main", &[("greeting.txt", "hello\n")]);
    fixture.create("mid", "main", &alice());
    fixture.create("child", "mid", &alice());
    fixture.commit("child", &[("greeting.txt", "hi\n")]);
    fixture.commit("mid", &[("greeting.txt", "hey\n")]);
    fixture.mark_all("mid");
    fixture.mark_all("child");
    fixture
}

#[test]
fn conflicts_refuse_unless_allowed() {
    let fixture = conflicting();
    expect!["refused: conflicts in greeting.txt"].assert_eq(&land(&fixture, "child"));
    expect!["landed into mid"].assert_eq(&land_allowing(
        &fixture,
        "child",
        &Allow::from_iter([SafeguardKind::Conflicted]),
    ));
    expect!["Next step: resolve conflicts in greeting.txt"].assert_eq(
        fixture
            .cabaret
            .show_page(&id("mid"))
            .unwrap()
            .to_string()
            .lines()
            .find(|line| line.starts_with("Next step"))
            .unwrap(),
    );
}

#[test]
fn empty_refuses_unless_allowed() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("empty", "main", &alice());
    expect!["refused: it adds nothing to main"].assert_eq(&land(&fixture, "empty"));
    expect!["landed into main"].assert_eq(&land_allowing(&fixture, "empty", &Allow::from_iter([SafeguardKind::Empty])));
    assert!(fixture.snapshot("empty").archived);
}

#[test]
fn unreviewed_parent_refuses_unless_allowed() {
    let fixture = conflicting();
    fixture.commit("mid", &[("greeting.txt", "hi\n")]);
    fixture.cabaret.rebase(&id("child"), None, &Allow::default()).unwrap();
    expect!["refused: alice@example.com has files of mid left to review"].assert_eq(&land(&fixture, "child"));
    expect!["landed into mid"].assert_eq(&land_allowing(
        &fixture,
        "child",
        &Allow::from_iter([SafeguardKind::ParentUnreviewed]),
    ));
}

#[test]
fn uncommitted_refuses_unless_allowed() {
    let fixture = diverged();
    fixture.checkout("child");
    fixture.write("draft.txt", "draft\n");
    expect!["refused: workspace main has uncommitted changes"].assert_eq(&land(&fixture, "child"));
    expect!["landed into main"].assert_eq(&land_allowing(
        &fixture,
        "child",
        &Allow::from_iter([SafeguardKind::Uncommitted]),
    ));
}

#[test]
fn permanent_change_stays_open() {
    let fixture = diverged();
    fixture.checkout("main");
    fixture.cabaret.set_permanent(&id("child"), true, &Allow::default()).unwrap();
    expect!["landed into main"].assert_eq(&land(&fixture, "child"));
    assert!(!fixture.snapshot("child").archived);
}

#[test]
fn unreviewed_refuses_unless_allowed() {
    let fixture = diverged();
    fixture.commit("child", &[("more.txt", "more\n")]);
    let tip = fixture.tip("main");
    expect!["refused: alice@example.com has files left to review"].assert_eq(&land(&fixture, "child"));
    assert_eq!(fixture.tip("main"), tip);
    expect!["landed into main"].assert_eq(&land_allowing(
        &fixture,
        "child",
        &Allow::from_iter([SafeguardKind::Unreviewed]),
    ));
}

#[test]
fn each_safeguard_needs_allowing() {
    let fixture = diverged();
    fixture.cabaret.set_owners(&id("child"), [bob()].into(), &Allow::default()).unwrap();
    expect!["refused: you (alice@example.com) are not an owner (owners: bob@example.com); bob@example.com has files left to review"].assert_eq(&land(&fixture, "child"));
    expect!["refused: you (alice@example.com) are not an owner (owners: bob@example.com)"].assert_eq(&land_allowing(
        &fixture,
        "child",
        &Allow::from_iter([SafeguardKind::Unreviewed]),
    ));
    expect!["landed into main"].assert_eq(&land_allowing(
        &fixture,
        "child",
        &Allow::from_iter([SafeguardKind::Unreviewed, SafeguardKind::NonOwner]),
    ));
}

#[test]
fn errors_come_before_safeguards() {
    let fixture = diverged();
    fixture.cabaret.set_owners(&id("child"), [bob()].into(), &Allow::default()).unwrap();
    fixture.archive("child");
    expect!["error: child is archived"].assert_eq(&land(&fixture, "child"));
}

#[test]
fn safeguards_foretell_refusal() {
    let fixture = diverged();
    fixture.cabaret.set_owners(&id("child"), [bob()].into(), &Allow::default()).unwrap();
    expect![
        "you (alice@example.com) are not an owner (owners: bob@example.com); bob@example.com has files left to review"
    ]
    .assert_eq(&shown(fixture.cabaret.land_safeguards(&id("child")).unwrap()));
}

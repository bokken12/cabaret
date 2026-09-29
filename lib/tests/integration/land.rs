//! Landing: the parent merges the change in and the change is archived.

use cabaret_lib::{LandAllow, Safeguard};
use expect_test::expect;

use super::fixture::{Fixture, alice, bob, id};

fn shown(safeguards: impl IntoIterator<Item: Into<Safeguard>>) -> String {
    let shown: Vec<String> = safeguards.into_iter().map(|safeguard| safeguard.into().to_string()).collect();
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

fn land(fixture: &Fixture, change: &str) -> String { land_allowing(fixture, change, LandAllow::default()) }

fn land_allowing(fixture: &Fixture, change: &str, allow: LandAllow) -> String {
    match fixture.cabaret.land(&id(change), allow) {
        Ok(Ok(parent)) => format!("landed into {parent}"),
        Ok(Err(refused)) => format!("refused: {}", shown(refused)),
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
fn parent_log_takes_landed_log_as_parent() {
    let fixture = diverged();
    let landed = fixture.log_head("child");
    expect!["landed into main"].assert_eq(&land(&fixture, "child"));
    assert_eq!(fixture.parents(fixture.log_head("main")), [landed]);
    expect![[r#"
        message "{\"action\":\"land\",\"change\":\"child\",\"log\":\"CHILD_LOG\"}\n"
        actions.jsonl "{\"action\":\"land\",\"change\":\"child\",\"log\":\"CHILD_LOG\"}\n"
        description.md ""
    "#]]
    .assert_eq(&fixture.metadata("main").replace(&landed.to_string(), "CHILD_LOG"));
}

#[test]
fn plain_branch_lands_without_log() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.branch("unlogged", "main");
    fixture.commit("unlogged", &[("unlogged.txt", "unlogged\n")]);
    expect!["landed into main"].assert_eq(&land_allowing(
        &fixture,
        "unlogged",
        LandAllow { unreviewed: true, non_owner: true },
    ));
    expect![[r#"
        message "{\"action\":\"land\",\"change\":\"unlogged\",\"log\":null}\n"
        actions.jsonl "{\"action\":\"land\",\"change\":\"unlogged\",\"log\":null}\n"
        description.md ""
    "#]]
    .assert_eq(&fixture.metadata("main"));
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
fn unreviewed_refuses_unless_allowed() {
    let fixture = diverged();
    fixture.commit("child", &[("more.txt", "more\n")]);
    let tip = fixture.tip("main");
    expect!["refused: alice@example.com has files left to review"].assert_eq(&land(&fixture, "child"));
    assert_eq!(fixture.tip("main"), tip);
    expect!["landed into main"].assert_eq(&land_allowing(
        &fixture,
        "child",
        LandAllow { unreviewed: true, non_owner: false },
    ));
}

#[test]
fn each_safeguard_needs_allowing() {
    let fixture = diverged();
    fixture.cabaret.set_owners(&id("child"), [bob()].into()).unwrap();
    expect!["refused: you (alice@example.com) are not an owner (owners: bob@example.com); bob@example.com has files left to review"].assert_eq(&land(&fixture, "child"));
    expect!["refused: you (alice@example.com) are not an owner (owners: bob@example.com)"].assert_eq(&land_allowing(
        &fixture,
        "child",
        LandAllow { unreviewed: true, non_owner: false },
    ));
    expect!["landed into main"].assert_eq(&land_allowing(
        &fixture,
        "child",
        LandAllow { unreviewed: true, non_owner: true },
    ));
}

#[test]
fn errors_come_before_safeguards() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("empty", "main", &bob());
    expect!["error: empty has nothing to land"].assert_eq(&land(&fixture, "empty"));
}

#[test]
fn safeguards_foretell_refusal() {
    let fixture = diverged();
    fixture.cabaret.set_owners(&id("child"), [bob()].into()).unwrap();
    expect![
        "you (alice@example.com) are not an owner (owners: bob@example.com); bob@example.com has files left to review"
    ]
    .assert_eq(&shown(fixture.cabaret.land_safeguards(&id("child")).unwrap()));
}

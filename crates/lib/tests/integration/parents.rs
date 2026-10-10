use cabaret_lib::{
    Error,
    safeguard::{Allow, SafeguardKind},
};
use expect_test::expect;
use nonempty_collections::nebts;

use super::fixture::{Fixture, alice, bob, id};

fn shown(attempt: cabaret_lib::Result<()>) -> String {
    match attempt {
        Ok(()) => "done".to_owned(),
        Err(Error::Refused(refused)) => {
            let shown: Vec<String> = refused.iter().map(ToString::to_string).collect();
            format!("refused: {}", shown.join("; "))
        }
        Err(error) => format!("error: {error:?}"),
    }
}

fn add_parent(fixture: &Fixture, change: &str, parent: &str, allow: &Allow) -> String {
    shown(fixture.cabaret.add_parent(&id(change), &id(parent), allow))
}

fn remove_parent(fixture: &Fixture, change: &str, parent: &str, allow: &Allow) -> String {
    shown(fixture.cabaret.remove_parent(&id(change), &id(parent), allow))
}

fn fix_parents(fixture: &Fixture, change: &str, allow: &Allow) -> String {
    shown(fixture.cabaret.fix_parents(&id(change), allow))
}

#[test]
fn unlogged_branch_is_root() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.branch("unlogged", "main");
    expect!["{}"].assert_eq(&format!("{:?}", fixture.snapshot("unlogged").parents));
}

#[test]
fn default_change_has_no_parents() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    expect!["{}"].assert_eq(&format!("{:?}", fixture.snapshot("main").parents));
}

#[test]
fn archived_parent_kept_until_fixed() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("parent", "main", &alice());
    fixture.create("child", "parent", &alice());
    fixture.archive("parent");
    expect![[r#"{"parent"}"#]].assert_eq(&format!("{:?}", fixture.snapshot("child").parents));
    expect!["done"].assert_eq(&fix_parents(&fixture, "child", &Allow::default()));
    expect![[r#"{"main"}"#]].assert_eq(&format!("{:?}", fixture.snapshot("child").parents));
}

#[test]
fn ancestor_of_parent_kept_until_fixed() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("parent", "main", &alice());
    fixture.create("child", "parent", &alice());
    expect!["refused: main is already an ancestor of parent"].assert_eq(&add_parent(
        &fixture,
        "child",
        "main",
        &Allow::default(),
    ));
    let allow = Allow::from_iter([SafeguardKind::RedundantParent]);
    expect!["done"].assert_eq(&add_parent(&fixture, "child", "main", &allow));
    expect![[r#"{"main", "parent"}"#]].assert_eq(&format!("{:?}", fixture.snapshot("child").parents));
    expect!["done"].assert_eq(&fix_parents(&fixture, "child", &Allow::default()));
    expect![[r#"{"parent"}"#]].assert_eq(&format!("{:?}", fixture.snapshot("child").parents));
}

#[test]
fn fix_moving_base_refuses_unless_allowed() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("abandoned", "main", &alice());
    fixture.commit("abandoned", &[("abandoned.txt", "abandoned\n")]);
    fixture.create("child", "abandoned", &alice());
    fixture.archive("abandoned");
    expect!["refused: its diff would take in the work of abandoned"].assert_eq(&fix_parents(
        &fixture,
        "child",
        &Allow::default(),
    ));
    let allow = Allow::from_iter([SafeguardKind::BaseMoves]);
    expect!["done"].assert_eq(&fix_parents(&fixture, "child", &allow));
    expect![[r#"{"main"}"#]].assert_eq(&format!("{:?}", fixture.snapshot("child").parents));
}

#[test]
fn children_are_open_changes_targeting_it() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("parent", "main", &alice());
    fixture.create("child", "parent", &alice());
    fixture.create("sibling", "main", &alice());
    fixture.archive("parent");
    let children = |change: &str| format!("{:?}", fixture.cabaret.children(&id(change)).unwrap());
    expect![[r#"{"sibling"}"#]].assert_eq(&children("main"));
    expect![[r#"{"child"}"#]].assert_eq(&children("parent"));
}

#[test]
fn created_parent_sits_between_child_and_its_parents() {
    let fixture = Fixture::new();
    fixture.root("main", &[("a", "1")]);
    fixture.create("child", "main", &alice());
    fixture.commit("child", &[("b", "2")]);
    fixture.commit("main", &[("c", "3")]);
    fixture.cabaret.create_parent("parent", &id("child"), &alice()).unwrap();
    let parent = fixture.snapshot("parent");
    expect![[r#"{"main"}"#]].assert_eq(&format!("{:?}", parent.parents));
    expect![[r#"{Identity("alice@example.com")}"#]].assert_eq(&format!("{:?}", parent.owners));
    assert_eq!(parent.tip, fixture.tip("main"));
    expect![[r#"{"parent"}"#]].assert_eq(&format!("{:?}", fixture.snapshot("child").parents));
    expect![[r#"
        child 26fb68bb
          parents parent
          owners alice@example.com
          title child
          base c2ab6603
          diff +b
    "#]]
    .assert_eq(&fixture.show("child"));
}

#[test]
fn created_parent_requires_base() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    let error = fixture.cabaret.create_parent("parent", &id("main"), &alice()).unwrap_err();
    expect!["main has no base to create a parent from"].assert_eq(&format!("{error:?}"));
}

#[test]
fn created_on_several_parents_starts_at_their_merge() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("left", "main", &alice());
    fixture.commit("left", &[("left.txt", "left\n")]);
    fixture.create("right", "main", &alice());
    fixture.commit("right", &[("right.txt", "right\n")]);
    fixture.cabaret.create("join", &nebts![id("left"), id("right")], &alice()).unwrap();
    expect![[r#"
        join
          parents left right
          owners alice@example.com
          title join
          base 536765ef
          diff (empty)
    "#]]
    .assert_eq(&fixture.describe("join"));
}

#[test]
fn created_on_conflicting_parents_carries_the_conflict() {
    let fixture = Fixture::new();
    fixture.root("main", &[("file.txt", "original\n")]);
    fixture.create("left", "main", &alice());
    fixture.commit("left", &[("file.txt", "left\n")]);
    fixture.create("right", "main", &alice());
    fixture.commit("right", &[("file.txt", "right\n")]);
    fixture.cabaret.create("join", &nebts![id("left"), id("right")], &alice()).unwrap();
    expect![[r#"
        join
          parents left right
          owners alice@example.com
          title join
          base ee2f96b1
          diff ~file.txt
    "#]]
    .assert_eq(&fixture.describe("join"));
    let tip = fixture.tip("join");
    expect![[r#"
        <<<<<<< join
        left
        ||||||| base
        original
        =======
        right
        >>>>>>> right
    "#]]
    .assert_eq(&fixture.text(tip, "file.txt").unwrap());
}

#[test]
fn cycle_refuses() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("parent", "main", &alice());
    fixture.create("child", "parent", &alice());
    expect!["error: child descends from parent, so it cannot be its parent"].assert_eq(&add_parent(
        &fixture,
        "parent",
        "child",
        &Allow::default(),
    ));
    expect!["error: parent cannot be its own parent"].assert_eq(&add_parent(
        &fixture,
        "parent",
        "parent",
        &Allow::default(),
    ));
}

#[test]
fn archived_parent_refuses_unless_allowed() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("done", "main", &alice());
    fixture.create("change", "main", &alice());
    fixture.archive("done");
    expect!["refused: done is archived"].assert_eq(&add_parent(&fixture, "change", "done", &Allow::default()));
    let allow = Allow::from_iter([SafeguardKind::ArchivedParent]);
    expect!["done"].assert_eq(&add_parent(&fixture, "change", "done", &allow));
}

#[test]
fn unrelated_root_shares_no_ancestor() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("change", "main", &alice());
    fixture.root("other", &[("other.txt", "other\n")]);
    expect!["refused: main, other share no ancestor, so it could never land"].assert_eq(&add_parent(
        &fixture,
        "change",
        "other",
        &Allow::default(),
    ));
}

#[test]
fn removal_moving_base_refuses_unless_allowed() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("parent", "main", &bob());
    fixture.commit("parent", &[("parent.txt", "parent\n")]);
    fixture.cabaret.create("child", &nebts![id("parent"), id("main")], &alice()).unwrap();
    fixture.commit("child", &[("child.txt", "child\n")]);
    expect!["refused: its diff would take in the work of parent"].assert_eq(&remove_parent(
        &fixture,
        "child",
        "parent",
        &Allow::default(),
    ));
    let allow = Allow::from_iter([SafeguardKind::BaseMoves]);
    expect!["done"].assert_eq(&remove_parent(&fixture, "child", "parent", &allow));
    expect![[r#"{"main"}"#]].assert_eq(&format!("{:?}", fixture.snapshot("child").parents));
}

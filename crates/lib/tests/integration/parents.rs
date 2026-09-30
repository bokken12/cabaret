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

#[test]
fn no_parents_implies_default_parent() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.branch("unlogged", "main");
    let snapshot = fixture.snapshot("unlogged");
    expect!["{}"].assert_eq(&format!("{:?}", snapshot.declared_parents));
    expect![[r#"{"main"}"#]].assert_eq(&format!("{:?}", snapshot.parents));
}

#[test]
fn default_change_has_no_parents() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    expect!["{}"].assert_eq(&format!("{:?}", fixture.snapshot("main").parents));
}

#[test]
fn archived_parent_replaced_by_grandparents() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("parent", "main", &alice());
    fixture.create("child", "parent", &alice());
    fixture.archive("parent");
    let snapshot = fixture.snapshot("child");
    expect![[r#"{"parent"}"#]].assert_eq(&format!("{:?}", snapshot.declared_parents));
    expect![[r#"{"main"}"#]].assert_eq(&format!("{:?}", snapshot.parents));
}

#[test]
fn ancestor_of_parent_dropped() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("parent", "main", &alice());
    fixture.create("child", "parent", &alice());
    expect!["refused: main is already an ancestor of parent, so it would be skipped"].assert_eq(&add_parent(
        &fixture,
        "child",
        "main",
        &Allow::default(),
    ));
    let allow = Allow::from_iter([SafeguardKind::RedundantParent]);
    expect!["done"].assert_eq(&add_parent(&fixture, "child", "main", &allow));
    let snapshot = fixture.snapshot("child");
    expect![[r#"{"main", "parent"}"#]].assert_eq(&format!("{:?}", snapshot.declared_parents));
    expect![[r#"{"parent"}"#]].assert_eq(&format!("{:?}", snapshot.parents));
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
    expect![[r#"{"child", "sibling"}"#]].assert_eq(&children("main"));
    expect!["{}"].assert_eq(&children("parent"));
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
    expect![[r#"{"main"}"#]].assert_eq(&format!("{:?}", parent.declared_parents));
    expect![[r#"{Identity("alice@example.com")}"#]].assert_eq(&format!("{:?}", parent.owners));
    assert_eq!(parent.tip, fixture.tip("main"));
    expect![[r#"{"parent"}"#]].assert_eq(&format!("{:?}", fixture.snapshot("child").declared_parents));
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
fn created_parent_of_unlogged_branch_sits_on_default() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.branch("unlogged", "main");
    let created = fixture.cabaret.create_parent("parent", &id("unlogged"), &alice());
    // TODO: `unlogged` targets main, so `parent` should be created on it.
    expect!["unlogged has no base to create a parent from"].assert_eq(&format!("{:?}", created.unwrap_err()));
}

#[test]
fn created_parent_skips_archived_parents() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("done", "main", &alice());
    fixture.create("child", "done", &alice());
    fixture.archive("done");
    fixture.commit("main", &[("a", "1")]);
    fixture.cabaret.create_parent("parent", &id("child"), &alice()).unwrap();
    let parent = fixture.snapshot("parent");
    // TODO: `done` is archived, so `parent` should declare main and start at its tip.
    expect![[r#"{"done"}"#]].assert_eq(&format!("{:?}", parent.declared_parents));
    assert_eq!(parent.tip, fixture.tip("done"));
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
    expect!["refused: done is archived, so it would be skipped"].assert_eq(&add_parent(
        &fixture,
        "change",
        "done",
        &Allow::default(),
    ));
    let allow = Allow::from_iter([SafeguardKind::ArchivedParent]);
    expect!["done"].assert_eq(&add_parent(&fixture, "change", "done", &allow));
}

/// A change declaring no parents lands into trunk, so trunk is common to nearly every set of
/// parents; only chains of archived changes declaring none can share no ancestor.
#[test]
fn inferred_trunk_is_common_ancestor() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("change", "main", &alice());
    fixture.root("other", &[("other.txt", "other\n")]);
    expect!["done"].assert_eq(&add_parent(&fixture, "change", "other", &Allow::default()));
}

#[test]
fn removal_moving_base_refuses_unless_allowed() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("parent", "main", &bob());
    fixture.commit("parent", &[("parent.txt", "parent\n")]);
    fixture.create("child", "parent", &alice());
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

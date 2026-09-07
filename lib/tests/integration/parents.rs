use expect_test::expect;
use nonempty_collections::nebts;

use super::fixture::{Fixture, alice, id};

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
    fixture.cabaret.archive(&id("parent")).unwrap();
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
    fixture.cabaret.add_parent(&id("child"), &id("main")).unwrap();
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
    fixture.cabaret.archive(&id("parent")).unwrap();
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
    fixture.cabaret.create_parent(&id("parent"), &id("child"), &alice()).unwrap();
    let parent = fixture.snapshot("parent");
    expect![[r#"{"main"}"#]].assert_eq(&format!("{:?}", parent.declared_parents));
    expect![[r#"{Identity("alice@example.com")}"#]].assert_eq(&format!("{:?}", parent.owners));
    assert_eq!(parent.tip, fixture.tip("main"));
    expect![[r#"{"parent"}"#]].assert_eq(&format!("{:?}", fixture.snapshot("child").declared_parents));
    expect![[r#"
        child 26fb68bb
          parents parent
          owners alice@example.com
          base c2ab6603
          diff +b
    "#]]
    .assert_eq(&fixture.show("child"));
}

#[test]
fn created_parent_requires_base() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    let error = fixture.cabaret.create_parent(&id("parent"), &id("main"), &alice()).unwrap_err();
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
    fixture.cabaret.create(&id("join"), nebts![id("left"), id("right")], &alice()).unwrap();
    expect![[r#"
        join
          parents left right
          owners alice@example.com
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
    fixture.cabaret.create(&id("join"), nebts![id("left"), id("right")], &alice()).unwrap();
    expect![[r#"
        join
          parents left right
          owners alice@example.com
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
    .assert_eq(&fixture.cabaret.blob(tip, &"file.txt".parse().unwrap()).unwrap().unwrap());
}

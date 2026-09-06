use expect_test::expect;

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
    let base = fixture.cabaret.base(&id("child")).unwrap().unwrap();
    fixture.cabaret.create_parent(&id("child"), &id("parent"), &alice()).unwrap();
    let parent = fixture.snapshot("parent");
    expect![[r#"{"main"}"#]].assert_eq(&format!("{:?}", parent.declared_parents));
    expect![[r#"{Identity("alice@example.com")}"#]].assert_eq(&format!("{:?}", parent.owners));
    assert_eq!(parent.tip, base);
    expect![[r#"{"parent"}"#]].assert_eq(&format!("{:?}", fixture.snapshot("child").declared_parents));
    expect![[r#"
        child 26fb68bb
          parents parent
          owners alice@example.com
          base parent
          diff +b
    "#]]
    .assert_eq(&fixture.show("child"));
}

#[test]
fn created_parent_requires_base() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    let error = fixture.cabaret.create_parent(&id("main"), &id("parent"), &alice()).unwrap_err();
    expect!["main has no base to start a parent from"].assert_eq(&format!("{error:?}"));
}

//! What a change targets is derived from what its log declares: no declaration means the default
//! branch, archived parents give way to their own parents, and ancestors of other parents drop out.

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

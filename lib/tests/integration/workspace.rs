//! Workspaces: which working directories exist and which change each holds.

use expect_test::expect;

use super::fixture::{Fixture, alice};

fn workspaces(fixture: &Fixture) -> String { format!("{:?}", fixture.cabaret.workspaces().unwrap()) }

fn two_changes() -> Fixture {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("one", "main", &alice());
    fixture.create("two", "main", &alice());
    fixture
}

#[test]
fn the_main_workspace_holds_the_checked_out_change() {
    let fixture = two_changes();
    fixture.checkout("one");
    expect![[r#"{"main": Some("one")}"#]].assert_eq(&workspaces(&fixture));
    expect![[r#"Some("main")"#]].assert_eq(&format!("{:?}", fixture.snapshot("one").workspace));
    expect!["None"].assert_eq(&format!("{:?}", fixture.snapshot("two").workspace));
}

#[test]
fn linked_workspaces_are_named_by_git() {
    let fixture = two_changes();
    fixture.checkout("one");
    let (_dir, _repo) = fixture.link_workspace("two");
    expect![[r#"{"main": Some("one"), "two": Some("two")}"#]].assert_eq(&workspaces(&fixture));
    expect![[r#"Some("two")"#]].assert_eq(&format!("{:?}", fixture.snapshot("two").workspace));
}

#[test]
fn a_detached_head_holds_no_change() {
    let fixture = two_changes();
    fixture.detach("one");
    expect![[r#"{"main": None}"#]].assert_eq(&workspaces(&fixture));
    expect!["None"].assert_eq(&format!("{:?}", fixture.snapshot("one").workspace));
}

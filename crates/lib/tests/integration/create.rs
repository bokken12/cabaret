//! Creating a change claims its id: an id already in use, whether by a cabaret change or a plain
//! git branch, is refused rather than silently reused.

use cabaret_lib::{
    Prefix, Scope,
    safeguard::{Allow, SafeguardKind},
};
use expect_test::expect;
use nonempty_collections::nebts;

use super::fixture::{Fixture, alice, bob, id};

#[test]
fn creating_an_existing_change_is_refused() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("child", "main", &alice());
    fixture.commit("child", &[("a", "1")]);
    let tip = fixture.tip("child");
    let error = fixture.cabaret.create("child", &nebts![id("main")], &bob(), &Allow::default()).unwrap_err();
    expect!["child already exists"].assert_eq(&format!("{error:?}"));
    assert_eq!(fixture.tip("child"), tip);
    expect![[r#"{Identity("alice@example.com")}"#]].assert_eq(&format!("{:?}", fixture.snapshot("child").owners));
}

#[test]
fn creating_over_a_plain_branch_is_refused() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.branch("unlogged", "main");
    let error = fixture.cabaret.create("unlogged", &nebts![id("main")], &alice(), &Allow::default()).unwrap_err();
    expect!["unlogged already exists"].assert_eq(&format!("{error:?}"));
}

#[test]
fn creating_an_archived_change_is_refused() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("child", "main", &alice());
    fixture.archive("child");
    let error = fixture.cabaret.create("child", &nebts![id("main")], &alice(), &Allow::default()).unwrap_err();
    expect!["child already exists"].assert_eq(&format!("{error:?}"));
}

#[test]
fn creating_child_of_archived_change_refuses_unless_allowed() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("done", "main", &alice());
    fixture.archive("done");
    let error = fixture.cabaret.create("child", &nebts![id("done")], &alice(), &Allow::default()).unwrap_err();
    expect!["refused: done is archived, so it would be skipped"].assert_eq(&format!("{error:?}"));
    expect![[r#"["done", "main"]"#]].assert_eq(&format!("{:?}", fixture.cabaret.changes().unwrap()));
    let allow = Allow::from_iter([SafeguardKind::ArchivedParent]);
    fixture.cabaret.create("child", &nebts![id("done")], &alice(), &allow).unwrap();
    expect![[r#"{"done"}"#]].assert_eq(&format!("{:?}", fixture.snapshot("child").declared_parents));
}

#[test]
fn creating_a_parent_with_an_existing_id_is_refused() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("child", "main", &alice());
    fixture.create("sibling", "main", &alice());
    let error = fixture.cabaret.create_parent("sibling", &id("child"), &alice()).unwrap_err();
    expect!["sibling already exists"].assert_eq(&format!("{error:?}"));
    expect![[r#"{"main"}"#]].assert_eq(&format!("{:?}", fixture.snapshot("child").declared_parents));
}

#[test]
fn prefix_goes_on_id_and_name_becomes_title() {
    let mut fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.cabaret.set_config(Scope::Local, &"alice/".parse::<Prefix>().unwrap()).unwrap();
    let created = fixture.cabaret.create("child", &nebts![id("main")], &alice(), &Allow::default()).unwrap();
    expect!["alice/child"].assert_eq(&created.to_string());
    expect![[r#"
        Some(
            "child",
        )
    "#]]
    .assert_debug_eq(&fixture.snapshot("alice/child").title);
}

#[test]
fn prefix_goes_on_created_parent() {
    let mut fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("child", "main", &alice());
    fixture.cabaret.set_config(Scope::Local, &"alice/".parse::<Prefix>().unwrap()).unwrap();
    let created = fixture.cabaret.create_parent("parent", &id("child"), &alice()).unwrap();
    expect!["alice/parent"].assert_eq(&created.to_string());
    expect![[r#"
        {
            "alice/parent",
        }
    "#]]
    .assert_debug_eq(&fixture.snapshot("child").declared_parents);
}

#[test]
fn empty_prefix_leaves_id_and_title_as_name() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("child", "main", &alice());
    assert_eq!(fixture.snapshot("child").title.as_deref(), Some("child"));
}

#[test]
fn name_that_cannot_be_id_is_refused() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    let error = fixture.cabaret.create("two words", &nebts![id("main")], &alice(), &Allow::default()).unwrap_err();
    expect![[r#"Reference name contains invalid byte: " ""#]].assert_eq(&format!("{error:?}"));
}

#[test]
fn titles_cover_changes_with_one() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("child", "main", &alice());
    fixture.branch("unlogged", "main");
    expect![[r#"
        {
            "child": "child",
        }
    "#]]
    .assert_debug_eq(&fixture.cabaret.titles().unwrap());
}

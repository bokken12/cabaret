//! Creating a change claims its id: an id already in use, whether by a cabaret change or a plain
//! git branch, is refused rather than silently reused.

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
    let error = fixture.cabaret.create(&id("child"), nebts![id("main")], &bob()).unwrap_err();
    expect!["child already exists"].assert_eq(&format!("{error:?}"));
    assert_eq!(fixture.tip("child"), tip);
    expect![[r#"{Identity("alice@example.com")}"#]].assert_eq(&format!("{:?}", fixture.snapshot("child").owners));
}

#[test]
fn creating_over_a_plain_branch_is_refused() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.branch("unlogged", "main");
    let error = fixture.cabaret.create(&id("unlogged"), nebts![id("main")], &alice()).unwrap_err();
    expect!["unlogged already exists"].assert_eq(&format!("{error:?}"));
}

#[test]
fn creating_an_archived_change_is_refused() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("child", "main", &alice());
    fixture.cabaret.archive(&id("child")).unwrap();
    let error = fixture.cabaret.create(&id("child"), nebts![id("main")], &alice()).unwrap_err();
    expect!["child already exists"].assert_eq(&format!("{error:?}"));
}

#[test]
fn creating_a_parent_with_an_existing_id_is_refused() {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("child", "main", &alice());
    fixture.create("sibling", "main", &alice());
    let error = fixture.cabaret.create_parent(&id("sibling"), &id("child"), &alice()).unwrap_err();
    expect!["sibling already exists"].assert_eq(&format!("{error:?}"));
    expect![[r#"{"main"}"#]].assert_eq(&format!("{:?}", fixture.snapshot("child").declared_parents));
}

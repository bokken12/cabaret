//! What a change says that its forge change does not yet.

use std::collections::BTreeSet;

use cabaret_lib::{
    Identity,
    log::{ForgeEvent, LogAction},
};
use expect_test::{Expect, expect};

use super::fixture::{Fixture, alice, bob, id};

/// `child` and `other` on `main`, owned by alice, who the fixture acts as.
fn child() -> Fixture {
    let fixture = Fixture::new();
    fixture.root("main", &[("greeting.txt", "hello\n")]);
    fixture.create("other", "main", &alice());
    fixture.create("child", "main", &alice());
    fixture
}

/// `child`'s forge change being opened as `title` into `main`.
fn opened(title: &str) -> ForgeEvent {
    ForgeEvent {
        id: "opened".parse().unwrap(),
        author: Identity("github:alice".into()),
        time: 20,
        actions: vec![
            LogAction::AddOwner { owner: Identity("github:alice".into()) },
            LogAction::SetTitle { title: Some(title.into()) },
            LogAction::AddParent { parent: id("main") },
        ],
    }
}

fn check(fixture: &Fixture, expected: &Expect) {
    expected.assert_eq(&format!("{:?}", fixture.cabaret.forge_exports().unwrap()));
}

#[test]
fn opens_forge_change_once_up_for_review_with_something_to_review() {
    let fixture = child();
    fixture.commit("child", &[("greeting.txt", "hi\n")]);
    check(&fixture, &expect!["[]"]);
    fixture.request_review("child");
    check(&fixture, &expect![[r#"[Open { change: "child", title: "child", parent: "main" }]"#]]);
    fixture.request_review("other");
    check(&fixture, &expect![[r#"[Open { change: "child", title: "child", parent: "main" }]"#]]);
}

#[test]
fn imported_forge_change_has_nothing_to_export() {
    let fixture = child();
    fixture.request_review("child");
    fixture.cabaret.import_forge_events(&id("child"), &[opened("child")]).unwrap();
    check(&fixture, &expect!["[]"]);
}

#[test]
fn edits_made_knowing_forge_change_are_exported() {
    let fixture = child();
    fixture.cabaret.import_forge_events(&id("child"), &[opened("Opened on forge")]).unwrap();
    fixture.cabaret.set_title(&id("child"), Some("Retitled here".into())).unwrap();
    check(&fixture, &expect![[r#"[Edit { change: "child", title: Some("Retitled here"), parent: None }]"#]]);
    let allow = BTreeSet::from(["redundant-parent".parse().unwrap(), "base-moves".parse().unwrap()]);
    fixture.cabaret.add_parent(&id("child"), &id("other"), &allow).unwrap();
    check(&fixture, &expect!["[]"]);
    fixture.cabaret.remove_parent(&id("child"), &id("main"), &allow).unwrap();
    check(&fixture, &expect![[r#"[Edit { change: "child", title: Some("Retitled here"), parent: Some("other") }]"#]]);
}

#[test]
fn edit_made_before_seeing_forge_change_loses_to_it() {
    let fixture = child();
    fixture.cabaret.set_title(&id("child"), Some("Titled before importing".into())).unwrap();
    fixture.cabaret.import_forge_events(&id("child"), &[opened("Opened on forge")]).unwrap();
    check(&fixture, &expect!["[]"]);
}

#[test]
fn changes_of_others_or_archived_are_left_alone() {
    let fixture = child();
    fixture.request_review("child");
    fixture.create("theirs", "main", &bob());
    fixture
        .cabaret
        .set_reviewing(&id("theirs"), cabaret_lib::Reviewing::Owners, &BTreeSet::from(["non-owner".parse().unwrap()]))
        .unwrap();
    fixture.archive("child");
    check(&fixture, &expect!["[]"]);
}

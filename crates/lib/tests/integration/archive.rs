//! Archiving: setting a change aside, and the safeguards on doing so or undoing it.

use std::collections::BTreeSet;

use cabaret_lib::{Error, safeguard::SafeguardKind};
use expect_test::expect;

use super::fixture::{Fixture, alice, id};

/// `parent` on `main`, and `child` on `parent`.
fn stacked() -> Fixture {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("parent", "main", &alice());
    fixture.create("child", "parent", &alice());
    fixture
}

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

fn archive(fixture: &Fixture, change: &str, allow: &BTreeSet<SafeguardKind>) -> String {
    shown(fixture.cabaret.archive(&id(change), allow))
}

fn unarchive(fixture: &Fixture, change: &str, allow: &BTreeSet<SafeguardKind>) -> String {
    shown(fixture.cabaret.unarchive(&id(change), allow))
}

#[test]
fn open_children_refuse_unless_allowed() {
    let fixture = stacked();
    expect!["refused: child still lands into it"].assert_eq(&archive(&fixture, "parent", &BTreeSet::new()));
    let allow = BTreeSet::from([SafeguardKind::OpenChildren]);
    expect!["done"].assert_eq(&archive(&fixture, "parent", &allow));
    expect![[r#"{"main"}"#]].assert_eq(&format!("{:?}", fixture.snapshot("child").parents));
}

#[test]
fn permanent_refuses_unless_allowed() {
    let fixture = stacked();
    fixture.cabaret.set_permanent(&id("child"), true, &BTreeSet::from([SafeguardKind::ImpermanentParents])).unwrap();
    expect!["refused: it is permanent"].assert_eq(&archive(&fixture, "child", &BTreeSet::new()));
    let allow = BTreeSet::from([SafeguardKind::Permanent]);
    expect!["done"].assert_eq(&archive(&fixture, "child", &allow));
}

#[test]
fn archived_parents_refuse_unarchiving_unless_allowed() {
    let fixture = stacked();
    fixture.archive("child");
    fixture.archive("parent");
    expect!["refused: parent is archived, so should not have unarchived children"].assert_eq(&unarchive(
        &fixture,
        "child",
        &BTreeSet::new(),
    ));
    expect!["done"].assert_eq(&unarchive(&fixture, "child", &BTreeSet::from([SafeguardKind::ArchivedParents])));
}

//! Owners: who shepherds a change, and the safeguards on removing them.

use cabaret_lib::{
    Error, Identity,
    safeguard::{Allow, SafeguardKind},
};
use expect_test::expect;

use super::fixture::{Fixture, alice, bob, id};

/// `change`, owned by alice, the fixture's identity, and bob.
fn co_owned() -> Fixture {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("change", "main", &alice());
    fixture.cabaret.add_owner(&id("change"), &bob()).unwrap();
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

fn owners(fixture: &Fixture) -> String {
    let owners: Vec<String> = fixture.snapshot("change").owners.iter().map(Identity::to_string).collect();
    owners.join(" ")
}

#[test]
fn removing_yourself_needs_no_allowing() {
    let fixture = co_owned();
    expect!["done"].assert_eq(&shown(fixture.cabaret.remove_owner(&id("change"), &alice(), &Allow::default())));
    expect!["bob@example.com"].assert_eq(&owners(&fixture));
}

#[test]
fn removing_others_refuses_unless_allowed() {
    let fixture = co_owned();
    expect!["refused: bob@example.com would no longer own it"].assert_eq(&shown(fixture.cabaret.remove_owner(
        &id("change"),
        &bob(),
        &Allow::default(),
    )));
    expect!["alice@example.com bob@example.com"].assert_eq(&owners(&fixture));
    let allow = Allow::from_iter([SafeguardKind::RemovesOthers]);
    expect!["done"].assert_eq(&shown(fixture.cabaret.remove_owner(&id("change"), &bob(), &allow)));
    expect!["alice@example.com"].assert_eq(&owners(&fixture));
}

#[test]
fn leaving_no_owners_refuses_unless_allowed() {
    let fixture = co_owned();
    let everyone = Allow::from_iter([SafeguardKind::RemovesOthers]);
    expect!["refused: it would have no owners"].assert_eq(&shown(fixture.cabaret.set_owners(
        &id("change"),
        &[].into(),
        &everyone,
    )));
    let allow = Allow::from_iter([SafeguardKind::RemovesOthers, SafeguardKind::Ownerless]);
    expect!["done"].assert_eq(&shown(fixture.cabaret.set_owners(&id("change"), &[].into(), &allow)));
    expect![""].assert_eq(&owners(&fixture));
}

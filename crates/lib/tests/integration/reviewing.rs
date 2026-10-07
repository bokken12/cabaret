//! Who a change is up for review by, and the safeguards on setting it.

use cabaret_lib::{
    Error, Reviewing,
    safeguard::{Allow, SafeguardKind},
};
use expect_test::expect;

use super::fixture::{Fixture, alice, bob, id};

fn feature() -> Fixture {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("feature", "main", &alice());
    fixture
}

fn set_reviewing(fixture: &Fixture, reviewing: Reviewing, allow: &Allow) -> String {
    match fixture.cabaret.set_reviewing(&id("feature"), reviewing, allow) {
        Ok(()) => format!("reviewing: {}", fixture.snapshot("feature").reviewing),
        Err(Error::Refused(refused)) => {
            let shown: Vec<String> = refused.iter().map(ToString::to_string).collect();
            format!("refused: {}", shown.join("; "))
        }
        Err(error) => format!("error: {error:?}"),
    }
}

#[test]
fn new_change_is_up_for_review_by_no_one() {
    let fixture = feature();
    expect!["none"].assert_eq(&fixture.snapshot("feature").reviewing.to_string());
}

#[test]
fn owner_sets_any_state() {
    let fixture = feature();
    let mut out = Vec::new();
    for reviewing in [Reviewing::Owners, Reviewing::All, Reviewing::None] {
        out.push(set_reviewing(&fixture, reviewing, &Allow::default()));
    }
    expect!["reviewing: owners; reviewing: all; reviewing: none"].assert_eq(&out.join("; "));
}

#[test]
fn setting_same_state_writes_nothing() {
    let fixture = feature();
    fixture.request_review("feature");
    let head = fixture.log_head("feature");
    fixture.request_review("feature");
    assert_eq!(fixture.log_head("feature"), head);
}

#[test]
fn non_owner_refuses_unless_allowed() {
    let fixture = feature();
    fixture.cabaret.set_owners(&id("feature"), &[bob()].into(), &Allow::default()).unwrap();
    expect!["refused: you (alice@example.com) are not an owner (owners: bob@example.com)"].assert_eq(&set_reviewing(
        &fixture,
        Reviewing::Owners,
        &Allow::default(),
    ));
    let allow = Allow::from_iter([SafeguardKind::NonOwner]);
    expect!["reviewing: owners"].assert_eq(&set_reviewing(&fixture, Reviewing::Owners, &allow));
}

//! Endorsing: an owner's approval of a change as a whole, which every owner gives before it lands.

use cabaret_lib::{
    Error,
    safeguard::{Allow, SafeguardKind},
};
use expect_test::expect;

use super::fixture::{Fixture, alice, id};

/// `feature`, owned by alice, adds a file on `main`.
fn feature() -> Fixture {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("feature", "main", &alice());
    fixture.commit("feature", &[("feature.txt", "feature\n")]);
    fixture
}

fn endorse(fixture: &Fixture, allow: &Allow) -> String {
    match fixture.cabaret.endorse(&id("feature"), allow) {
        Ok(()) => format!("endorsers: {:?}", fixture.snapshot("feature").endorsers),
        Err(Error::Refused(refused)) => {
            let shown: Vec<String> = refused.iter().map(ToString::to_string).collect();
            format!("refused: {}", shown.join("; "))
        }
        Err(error) => format!("error: {error:?}"),
    }
}

#[test]
fn reviewed_change_endorses() {
    let fixture = feature();
    fixture.mark_all("feature");
    expect![[r#"endorsers: {Identity("alice@example.com")}"#]].assert_eq(&endorse(&fixture, &Allow::default()));
}

#[test]
fn unreviewed_refuses_unless_allowed() {
    let fixture = feature();
    expect!["refused: alice@example.com has files left to review"].assert_eq(&endorse(&fixture, &Allow::default()));
    let allow = Allow::from_iter([SafeguardKind::Unreviewed]);
    expect![[r#"endorsers: {Identity("alice@example.com")}"#]].assert_eq(&endorse(&fixture, &allow));
}

#[test]
fn endorsing_again_writes_nothing() {
    let fixture = feature();
    fixture.mark_all("feature");
    fixture.endorse("feature");
    let head = fixture.log_head("feature");
    expect![[r#"endorsers: {Identity("alice@example.com")}"#]].assert_eq(&endorse(&fixture, &Allow::default()));
    assert_eq!(fixture.log_head("feature"), head);
}

#[test]
fn unendorse_withdraws() {
    let fixture = feature();
    fixture.mark_all("feature");
    fixture.endorse("feature");
    fixture.cabaret.unendorse(&id("feature")).unwrap();
    assert!(fixture.snapshot("feature").endorsers.is_empty());
    let head = fixture.log_head("feature");
    fixture.cabaret.unendorse(&id("feature")).unwrap();
    assert_eq!(fixture.log_head("feature"), head);
}

#[test]
fn log_records_endorsement() {
    let fixture = feature();
    fixture.mark_all("feature");
    fixture.endorse("feature");
    fixture.cabaret.unendorse(&id("feature")).unwrap();
    expect![[r#"
        {"action":"unendorse","endorser":"alice@example.com"}
    "#]]
    .assert_eq(&fixture.message(fixture.log_head("feature")));
    expect![[r#"
        {"action":"endorse","endorser":"alice@example.com"}
    "#]]
    .assert_eq(&fixture.message(fixture.parents(fixture.log_head("feature"))[0]));
}

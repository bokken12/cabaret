//! Permanence: changes that stay open as others land into them, and the safeguards on marking one.

use cabaret_lib::safeguard::{OwnersAllow, PermanenceAllow, Safeguard};
use expect_test::expect;

use super::fixture::{Fixture, alice, bob, id};

/// `feature` on `main`, and `child` on `feature`, all owned by alice, the fixture's identity.
fn stacked() -> Fixture {
    let fixture = Fixture::new();
    fixture.root("main", &[]);
    fixture.create("feature", "main", &alice());
    fixture.create("child", "feature", &alice());
    fixture
}

fn set_permanent(fixture: &Fixture, change: &str, permanent: bool, allow: PermanenceAllow) -> String {
    match fixture.cabaret.set_permanent(&id(change), permanent, allow) {
        Ok(Ok(())) => format!("permanent: {}", fixture.snapshot(change).permanent),
        Ok(Err(refused)) => {
            let shown: Vec<String> =
                refused.into_iter().map(|safeguard| Safeguard::from(safeguard).to_string()).collect();
            format!("refused: {}", shown.join("; "))
        }
        Err(error) => format!("error: {error:?}"),
    }
}

#[test]
fn change_on_root_needs_no_allowing() {
    let fixture = stacked();
    expect!["permanent: true"].assert_eq(&set_permanent(&fixture, "feature", true, PermanenceAllow::default()));
}

#[test]
fn impermanent_parent_refuses_unless_allowed() {
    let fixture = stacked();
    expect!["refused: feature is not permanent"].assert_eq(&set_permanent(
        &fixture,
        "child",
        true,
        PermanenceAllow::default(),
    ));
    let allow = PermanenceAllow { impermanent_parents: true, ..PermanenceAllow::default() };
    expect!["permanent: true"].assert_eq(&set_permanent(&fixture, "child", true, allow));
    expect!["permanent: false"].assert_eq(&set_permanent(&fixture, "child", false, PermanenceAllow::default()));
}

#[test]
fn non_owner_refuses_unless_allowed() {
    let fixture = stacked();
    fixture.cabaret.set_owners(&id("feature"), [bob()].into(), OwnersAllow::default()).unwrap().unwrap();
    expect!["refused: you (alice@example.com) are not an owner (owners: bob@example.com)"].assert_eq(&set_permanent(
        &fixture,
        "feature",
        true,
        PermanenceAllow::default(),
    ));
    let allow = PermanenceAllow { non_owner: true, ..PermanenceAllow::default() };
    expect!["permanent: true"].assert_eq(&set_permanent(&fixture, "feature", true, allow));
}

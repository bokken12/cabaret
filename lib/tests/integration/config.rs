//! Settings live in the repository's git config; identity falls back to git's user.email.

use cabaret_lib::Identity;

use super::fixture::{Fixture, alice, bob};

#[test]
fn identity_defaults_to_git_user_email() {
    let fixture = Fixture::new();
    assert_eq!(fixture.cabaret.setting::<Identity>().unwrap(), None);
    assert_eq!(fixture.cabaret.identity().unwrap(), alice());
}

#[test]
fn set_identity_overrides_user_email_until_unset() {
    let fixture = Fixture::new();
    fixture.cabaret.set_setting(Some(&bob())).unwrap();
    assert_eq!(fixture.cabaret.setting::<Identity>().unwrap(), Some(bob()));
    assert_eq!(fixture.cabaret.identity().unwrap(), bob());
    assert!(fixture.config().contains("[cabaret]\n\tidentity = bob@example.com\n"), "{}", fixture.config());

    fixture.cabaret.set_setting::<Identity>(None).unwrap();
    assert_eq!(fixture.cabaret.setting::<Identity>().unwrap(), None);
    assert_eq!(fixture.cabaret.identity().unwrap(), alice());
    assert!(!fixture.config().contains("identity"), "{}", fixture.config());
}

#[test]
fn setting_again_replaces_rather_than_appends() {
    let fixture = Fixture::new();
    fixture.cabaret.set_setting(Some(&bob())).unwrap();
    fixture.cabaret.set_setting(Some(&alice())).unwrap();
    assert_eq!(fixture.config().matches("identity").count(), 1, "{}", fixture.config());
    assert_eq!(fixture.cabaret.identity().unwrap(), alice());
}

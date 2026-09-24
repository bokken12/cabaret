//! Settings live in git config: writing one rewrites the scope's file, and the writer reads the
//! new value back without reopening.

use cabaret_lib::{Identity, Scope};
use expect_test::expect;

use super::fixture::{Fixture, bob};

#[test]
fn set_setting_is_written_to_local_config_and_read_back() {
    let mut fixture = Fixture::new();
    fixture.cabaret.set_config(Scope::Local, &bob()).unwrap();
    assert_eq!(fixture.cabaret.config::<Identity>().unwrap(), Some(bob()));
    assert_eq!(fixture.cabaret.identity().unwrap(), bob());
    expect![[r#"
        [user]
        	name = Alice Test
        	email = bob@example.com
    "#]]
    .assert_eq(&fixture.local_config("user"));
}

#[test]
fn unset_setting_is_removed_from_local_config() {
    let mut fixture = Fixture::new();
    fixture.cabaret.unset_config::<Identity>(Scope::Local).unwrap();
    expect![[r#"
        [user]
        	name = Alice Test
    "#]]
    .assert_eq(&fixture.local_config("user"));
}

#[test]
fn unsetting_absent_setting_is_refused() {
    let mut fixture = Fixture::new();
    fixture.cabaret.unset_config::<Identity>(Scope::Local).unwrap();
    let error = fixture.cabaret.unset_config::<Identity>(Scope::Local).unwrap_err();
    expect!["user.email is not set in local config"].assert_eq(&format!("{error:?}"));
}

#[test]
fn malformed_identity_is_refused() {
    let error = "Bob <bob@example.com>".parse::<Identity>().unwrap_err();
    expect![[r#""Bob <bob@example.com>" cannot be a git user.email"#]].assert_eq(&format!("{error:?}"));
}

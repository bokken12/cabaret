//! Settings live in git config: writing one rewrites the scope's file, and the writer reads the
//! new value back without reopening.

use cabaret_lib::{FetchInterval, Hints, Identity, Scope};
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

#[test]
fn hints_parse_as_git_booleans() {
    let parsed =
        ["true", "yes", "on", "1", "false", "no", "off", "0", "maybe"].map(|value| (value, value.parse::<Hints>()));
    expect![[r#"
        [
            (
                "true",
                Ok(
                    Shown,
                ),
            ),
            (
                "yes",
                Ok(
                    Shown,
                ),
            ),
            (
                "on",
                Ok(
                    Shown,
                ),
            ),
            (
                "1",
                Ok(
                    Shown,
                ),
            ),
            (
                "false",
                Ok(
                    Hidden,
                ),
            ),
            (
                "no",
                Ok(
                    Hidden,
                ),
            ),
            (
                "off",
                Ok(
                    Hidden,
                ),
            ),
            (
                "0",
                Ok(
                    Hidden,
                ),
            ),
            (
                "maybe",
                Err(
                    "maybe" is not a boolean,
                ),
            ),
        ]
    "#]]
    .assert_debug_eq(&parsed);
}

#[test]
fn fetch_interval_parses_as_seconds_with_zero_never() {
    let parsed = ["60", "0", "-1", "1m"].map(|value| (value, value.parse::<FetchInterval>()));
    expect![[r#"
        [
            (
                "60",
                Ok(
                    Seconds(
                        60,
                    ),
                ),
            ),
            (
                "0",
                Ok(
                    Never,
                ),
            ),
            (
                "-1",
                Err(
                    "-1" is not a number of seconds,
                ),
            ),
            (
                "1m",
                Err(
                    "1m" is not a number of seconds,
                ),
            ),
        ]
    "#]]
    .assert_debug_eq(&parsed);
}

use cabaret_lib::{Identity, log};
use expect_test::expect;

#[test]
fn empty_identity_is_refused() {
    expect![[r#""" cannot be a git user.email"#]].assert_eq(&format!("{:?}", "".parse::<Identity>().unwrap_err()));
}

#[test]
fn log_owner_is_parsed_as_identity() {
    expect![[r#""" cannot be a git user.email"#]]
        .assert_eq(&format!("{:?}", log::parse(r#"{"action":"add-owner","owner":""}"#).unwrap_err()));
}

//! Refusals by safeguards, and the flag they name to allow each.

use cabaret_cli::report;
use cabaret_lib::{Error, Identity, safeguard::Safeguard};
use expect_test::expect;
use nonempty_collections::{nebts, nev};

fn identity(email: &str) -> Identity { email.parse().unwrap() }

fn non_owner() -> Safeguard {
    Safeguard::NonOwner { you: identity("alice@example.com"), owners: [identity("bob@example.com")].into() }
}

#[test]
fn one_safeguard_on_one_line() {
    let refused = nev![non_owner()];
    expect![
        "cab: you (alice@example.com) are not an owner (owners: bob@example.com); pass --allow non-owner to override"
    ]
    .assert_eq(&report(&Error::Refused(refused)));
}

#[test]
fn several_safeguards_one_per_line() {
    let refused = nev![non_owner(), Safeguard::Unreviewed { reviewers: nebts![identity("bob@example.com")] }];
    expect![[r#"
        cab: you (alice@example.com) are not an owner (owners: bob@example.com); pass --allow non-owner to override
        cab: bob@example.com has files left to review; pass --allow unreviewed to override"#]]
    .assert_eq(&report(&Error::Refused(refused)));
}

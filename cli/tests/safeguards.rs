//! Refusals by safeguards, and the flag they name to allow each.

use cabaret_cli::change::refusal;
use cabaret_lib::{
    ChangeId, Error, Identity,
    safeguard::{NonOwner, Safeguard, Unreviewed},
};
use expect_test::expect;
use nonempty_collections::{nebts, nev};

fn child() -> ChangeId { "child".parse().unwrap() }

fn identity(email: &str) -> Identity { email.parse().unwrap() }

fn non_owner() -> NonOwner {
    NonOwner { you: identity("alice@example.com"), owners: [identity("bob@example.com")].into() }
}

#[test]
fn one_safeguard_on_one_line() {
    let refused = nev![Safeguard::NonOwner(non_owner())];
    expect!["cannot rebase child: you (alice@example.com) are not an owner (owners: bob@example.com); pass --allow non-owner to override"]
        .assert_eq(&format!("{:?}", refusal(&format!("rebase {}", child()), Error::Refused(refused))));
}

#[test]
fn several_safeguards_one_per_line() {
    let refused = nev![
        Safeguard::NonOwner(non_owner()),
        Safeguard::Unreviewed(Unreviewed { reviewers: nebts![identity("bob@example.com")] }),
    ];
    expect![[r#"
        cannot land child:
          you (alice@example.com) are not an owner (owners: bob@example.com); pass --allow non-owner to override
          bob@example.com has files left to review; pass --allow unreviewed to override"#]]
    .assert_eq(&format!("{:?}", refusal(&format!("land {}", child()), Error::Refused(refused))));
}

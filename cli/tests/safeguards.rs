//! Refusals by safeguards, and the flags they name to allow each.

use cabaret_cli::change::{ChangeCommand, refusal};
use cabaret_lib::{ChangeId, Identity, LandSafeguard, NonOwner, RebaseSafeguard, SafeguardKind, Unreviewed};
use clap::Parser;
use expect_test::expect;
use nonempty_collections::{nebts, nev};

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: ChangeCommand,
}

fn child() -> ChangeId { "child".parse().unwrap() }

fn identity(email: &str) -> Identity { email.parse().unwrap() }

fn non_owner() -> NonOwner {
    NonOwner { you: identity("alice@example.com"), owners: [identity("bob@example.com")].into() }
}

#[test]
fn one_safeguard_on_one_line() {
    let refused = nev![RebaseSafeguard::NonOwner(non_owner())];
    expect!["cannot rebase child: you (alice@example.com) are not an owner (owners: bob@example.com); pass --allow-non-owner to rebase anyway"]
        .assert_eq(&format!("{:?}", refusal("rebase", &child(), refused)));
}

#[test]
fn several_safeguards_one_per_line() {
    let refused = nev![
        LandSafeguard::NonOwner(non_owner()),
        LandSafeguard::Unreviewed(Unreviewed { reviewers: nebts![identity("bob@example.com")] }),
    ];
    expect![[r#"
        cannot land child:
          you (alice@example.com) are not an owner (owners: bob@example.com); pass --allow-non-owner to land anyway
          bob@example.com has files left to review; pass --allow-unreviewed to land anyway"#]]
    .assert_eq(&format!("{:?}", refusal("land", &child(), refused)));
}

/// Refusals name `--allow-<kind>`, so each command needs a flag spelled so for every safeguard it checks.
#[test]
fn flags_match_kinds() {
    let allow = |kind: SafeguardKind| format!("--allow-{kind}");
    let land = ["cab", "land", &allow(SafeguardKind::Unreviewed), &allow(SafeguardKind::NonOwner)];
    Cli::try_parse_from(land).unwrap();
    Cli::try_parse_from(["cab", "rebase", &allow(SafeguardKind::NonOwner)]).unwrap();
}

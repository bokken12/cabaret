//! Refusals by safeguards, and the flags they name to allow each.

use cabaret_cli::change::{ChangeCommand, refusal};
use cabaret_lib::{
    ChangeId, Identity,
    safeguard::{
        AddParentAllow, LandAllow, LandSafeguard, NonOwner, OwnersAllow, RebaseAllow, RebaseSafeguard,
        RemoveParentAllow, SafeguardKind, Unreviewed,
    },
};
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
    expect!["cannot rebase child: you (alice@example.com) are not an owner (owners: bob@example.com); pass --allow-non-owner to override"]
        .assert_eq(&format!("{:?}", refusal(&format!("rebase {}", child()), refused)));
}

#[test]
fn several_safeguards_one_per_line() {
    let refused = nev![
        LandSafeguard::NonOwner(non_owner()),
        LandSafeguard::Unreviewed(Unreviewed { reviewers: nebts![identity("bob@example.com")] }),
    ];
    expect![[r#"
        cannot land child:
          you (alice@example.com) are not an owner (owners: bob@example.com); pass --allow-non-owner to override
          bob@example.com has files left to review; pass --allow-unreviewed to override"#]]
    .assert_eq(&format!("{:?}", refusal(&format!("land {}", child()), refused)));
}

/// Refusals name `--allow-<kind>`, so each command needs a flag spelled so for every safeguard it checks.
#[test]
fn flags_match_kinds() {
    let parse = |command: &str, kinds: &[SafeguardKind]| {
        let flags = kinds.iter().map(|kind| format!("--allow-{kind}"));
        Cli::try_parse_from(["cab".to_owned(), command.to_owned()].into_iter().chain(flags)).unwrap();
    };
    parse("land", LandAllow::KINDS);
    parse("rebase", RebaseAllow::KINDS);
    let owners = |command: &str| {
        let flags = OwnersAllow::KINDS.iter().map(|kind| format!("--allow-{kind}"));
        let args = ["cab", "owners", command, "me@example.com"].map(str::to_owned);
        Cli::try_parse_from(args.into_iter().chain(flags)).unwrap();
    };
    owners("remove");
    owners("set");
    let parents = |command: &str, kinds: &[SafeguardKind]| {
        let flags = kinds.iter().map(|kind| format!("--allow-{kind}"));
        let args = ["cab", "parents", command, "main"].map(str::to_owned);
        Cli::try_parse_from(args.into_iter().chain(flags)).unwrap();
    };
    parents("add", AddParentAllow::KINDS);
    parents("remove", RemoveParentAllow::KINDS);
}

//! Argument values: safeguard kinds, and those needing the repository: parsing revisions,
//! and completing changes and revisions.

use std::ffi::OsStr;

use cabaret_lib::{Cabaret, Result, Reviewing, RevisionId, safeguard::SafeguardKind};
use clap::builder::{PossibleValuesParser, TypedValueParser};
use clap_complete::{ArgValueCompleter, CompletionCandidate};

pub fn safeguard_kind() -> impl TypedValueParser<Value = SafeguardKind> {
    PossibleValuesParser::new(SafeguardKind::ALL.iter().map(|kind| kind.name())).map(|name| {
        *SafeguardKind::ALL.iter().find(|kind| kind.name() == name).expect("only safeguard kinds are possible")
    })
}

pub fn reviewing() -> impl TypedValueParser<Value = Reviewing> {
    PossibleValuesParser::new(Reviewing::ALL.iter().map(|reviewing| reviewing.name())).map(|name| {
        *Reviewing::ALL.iter().find(|reviewing| reviewing.name() == name).expect("only reviewing states are possible")
    })
}

fn cabaret() -> Result<Cabaret> { Cabaret::open(std::env::current_dir()?) }

fn changes() -> Result<Vec<String>> { Ok(cabaret()?.changes()?.into_iter().map(|change| change.to_string()).collect()) }

fn completer(candidates: fn() -> Result<Vec<String>>) -> ArgValueCompleter {
    ArgValueCompleter::new(move |current: &OsStr| {
        let Some(current) = current.to_str() else { return Vec::new() };
        candidates()
            .unwrap_or_default()
            .into_iter()
            .filter(|candidate| candidate.starts_with(current))
            .map(CompletionCandidate::new)
            .collect()
    })
}

pub fn change_completer() -> ArgValueCompleter { completer(changes) }

/// Any revision spec is accepted; changes and HEAD are the ones worth offering.
pub fn revision_completer() -> ArgValueCompleter {
    completer(|| Ok(changes()?.into_iter().chain(["HEAD".to_owned()]).collect()))
}

/// A clap value parser resolving `spec` in the repository at the working directory.
pub fn parse_revision(spec: &str) -> std::result::Result<RevisionId, String> {
    cabaret().and_then(|cabaret| cabaret.resolve(spec)).map_err(|error| format!("{error:?}"))
}

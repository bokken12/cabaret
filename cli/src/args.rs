//! Argument values: the safeguards to allow, and those needing the repository: parsing revisions,
//! and completing changes and revisions.

use std::ffi::OsStr;

use cabaret_lib::{
    Cabaret, Result, RevisionId,
    safeguard::{Allow, SafeguardKind},
};
use clap::{
    Args,
    builder::{PossibleValuesParser, TypedValueParser},
};
use clap_complete::{ArgValueCompleter, CompletionCandidate};

// The safeguards a command is told to go ahead despite. Not a doc comment, which clap would show
// as the about of every command without its own.
#[derive(Args)]
pub struct Allowing {
    /// Go ahead despite safeguards of this kind; repeat for several.
    #[arg(long = "allow", value_name = "SAFEGUARD", value_parser = safeguard_kind())]
    kinds: Vec<SafeguardKind>,
}

impl From<Allowing> for Allow {
    fn from(allowing: Allowing) -> Self { allowing.kinds.into_iter().collect() }
}

fn safeguard_kind() -> impl TypedValueParser<Value = SafeguardKind> {
    PossibleValuesParser::new(SafeguardKind::ALL.iter().map(|kind| kind.name())).map(|name| {
        *SafeguardKind::ALL.iter().find(|kind| kind.name() == name).expect("only safeguard kinds are possible")
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

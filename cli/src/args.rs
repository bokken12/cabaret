//! Argument values that need the repository: parsing revisions, and completing changes and revisions.

use std::ffi::OsStr;

use cabaret_lib::{Cabaret, Result, Revision};
use clap_complete::{ArgValueCompleter, CompletionCandidate};

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
pub fn parse_revision(spec: &str) -> std::result::Result<Revision, String> {
    cabaret().and_then(|cabaret| cabaret.resolve(spec)).map_err(|error| format!("{error:?}"))
}

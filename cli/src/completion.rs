use std::ffi::OsStr;

use cabaret_lib::{cabaret::Cabaret, change::ChangeId, error::Result};
use clap_complete::{ArgValueCompleter, CompletionCandidate};

pub fn change_completer() -> ArgValueCompleter {
    fn changes() -> Result<Vec<ChangeId>> { Cabaret::open(std::env::current_dir()?)?.changes() }
    ArgValueCompleter::new(|current: &OsStr| {
        let Some(current) = current.to_str() else { return Vec::new() };
        changes()
            .unwrap_or_default()
            .into_iter()
            .map(|change| change.to_string())
            .filter(|change| change.starts_with(current))
            .map(CompletionCandidate::new)
            .collect()
    })
}

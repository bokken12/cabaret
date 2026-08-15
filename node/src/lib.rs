// The napi boundary requires owned values for JS primitives.
#![allow(clippy::needless_pass_by_value)]

use cabaret_lib::Cabaret;
use napi_derive::napi;

fn napi_error(error: &cabaret_lib::Error) -> napi::Error { napi::Error::from_reason(format!("{error:?}")) }

fn open(dir: &str) -> napi::Result<Cabaret> { Cabaret::open(dir).map_err(|error| napi_error(&error)) }

#[napi]
pub fn changes(dir: String) -> napi::Result<Vec<String>> {
    let changes = open(&dir)?.changes().map_err(|error| napi_error(&error))?;
    Ok(changes.iter().map(ToString::to_string).collect())
}

#[napi]
pub fn current_change(dir: String) -> napi::Result<String> {
    let change = open(&dir)?.current_change().map_err(|error| napi_error(&error))?;
    Ok(change.to_string())
}

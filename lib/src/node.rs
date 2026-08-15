// The napi boundary requires owned values for JS primitives.
#![allow(clippy::needless_pass_by_value)]

use crate::Cabaret;
use napi_derive::napi;

#[napi]
pub fn changes(dir: String) -> napi::Result<Vec<String>> {
    Ok(Cabaret::open(&dir)?.changes()?.iter().map(ToString::to_string).collect())
}

#[napi]
pub fn current_change(dir: String) -> napi::Result<String> {
    Ok(Cabaret::open(&dir)?.current_change()?.to_string())
}

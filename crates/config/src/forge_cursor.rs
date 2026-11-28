use std::{fmt, str::FromStr};

use cabaret_types::{Error, Result, TimestampS};

use crate::Setting;

/// When the most recently changed forge change this repository has imported last changed, so
/// that syncing asks the forge only for what has changed since.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ForgeCursor(pub TimestampS);

impl FromStr for ForgeCursor {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self> {
        Ok(Self(value.parse().map_err(|_| format!("{value:?} is not a time in seconds"))?))
    }
}

impl fmt::Display for ForgeCursor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "{}", self.0) }
}

impl Setting for ForgeCursor {
    const KEY: &'static str = "cabaret.forge.imported";
}

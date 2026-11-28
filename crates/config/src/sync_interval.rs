use std::{fmt, num::NonZeroU32, str::FromStr};

use cabaret_types::{Error, Result};

use crate::Setting;

/// How often editors sync with origin in the background, stored as seconds, `0` for never.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncInterval {
    Never,
    Seconds(NonZeroU32),
}

impl Default for SyncInterval {
    fn default() -> Self { Self::Seconds(NonZeroU32::new(60).expect("60 is not zero")) }
}

impl FromStr for SyncInterval {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self> {
        let seconds: u32 = value.parse().map_err(|_| format!("{value:?} is not a number of seconds"))?;
        Ok(NonZeroU32::new(seconds).map_or(Self::Never, Self::Seconds))
    }
}

impl fmt::Display for SyncInterval {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Never => f.write_str("0"),
            Self::Seconds(seconds) => write!(f, "{seconds}"),
        }
    }
}

impl Setting for SyncInterval {
    const KEY: &'static str = "cabaret.vscode.syncInterval";
}

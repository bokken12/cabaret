use std::{fmt, str::FromStr};

use cabaret_types::{Error, Result};

use crate::Setting;

/// Whether frontends show keybinding hints, stored as a git boolean.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Hints {
    #[default]
    Shown,
    Hidden,
}

impl FromStr for Hints {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self> {
        let shown: bool =
            gix::config::Boolean::try_from(value).map_err(|_| format!("{value:?} is not a boolean"))?.into();
        Ok(match shown {
            true => Self::Shown,
            false => Self::Hidden,
        })
    }
}

impl fmt::Display for Hints {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Shown => "true",
            Self::Hidden => "false",
        })
    }
}

impl Setting for Hints {
    const KEY: &'static str = "cabaret.hints";
}

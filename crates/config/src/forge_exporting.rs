use std::{fmt, str::FromStr};

use cabaret_types::{Error, Result};

use crate::Setting;

/// Whether syncing writes to the forge what changes say that their forge changes do not, stored
/// as a git boolean. Importing from the forge needs no such leave: it only reads.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ForgeExporting {
    #[default]
    Off,
    On,
}

impl FromStr for ForgeExporting {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self> {
        let on: bool = gix::config::Boolean::try_from(value).map_err(|_| format!("{value:?} is not a boolean"))?.into();
        Ok(match on {
            true => Self::On,
            false => Self::Off,
        })
    }
}

impl fmt::Display for ForgeExporting {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::On => "true",
            Self::Off => "false",
        })
    }
}

impl Setting for ForgeExporting {
    const KEY: &'static str = "cabaret.forge.export";
}

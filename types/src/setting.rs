use std::{fmt, fmt::Display, str::FromStr};

use crate::Error;

/// A value cabaret keeps in git config under `KEY`, stored as its `Display` and read back by
/// its `FromStr`.
pub trait Setting: FromStr<Err = Error> + Display {
    const KEY: &'static str;
}

/// Which git config file a setting is written to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// The repository's own, shared by all its workspaces.
    Local,
    /// The user's, read by every repository.
    Global,
}

impl Display for Scope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Scope::Local => "local",
            Scope::Global => "global",
        })
    }
}

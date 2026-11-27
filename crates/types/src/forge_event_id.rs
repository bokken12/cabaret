use std::{fmt, str::FromStr};

use crate::Error;

/// The id a forge gives one event in a forge change's history, such as a rename or a review.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ForgeEventId(String);

impl fmt::Display for ForgeEventId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(&self.0) }
}

impl FromStr for ForgeEventId {
    type Err = Error;

    fn from_str(id: &str) -> Result<Self, Error> {
        if id.is_empty() || id.contains(char::is_whitespace) {
            Err(format!("{id:?} cannot be a forge event id"))?;
        }
        Ok(Self(id.to_owned()))
    }
}

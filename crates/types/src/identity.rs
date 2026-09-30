use std::{fmt, str::FromStr};

use serde::{Deserialize, Deserializer, Serialize};

use crate::Error;

// TODO-someday(joel): rename to "user" or "email"?
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
pub struct Identity(String);

impl AsRef<str> for Identity {
    fn as_ref(&self) -> &str { &self.0 }
}

impl fmt::Display for Identity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(&self.0) }
}

impl FromStr for Identity {
    type Err = Error;

    fn from_str(email: &str) -> Result<Self, Error> {
        if email.is_empty() || email.contains(['<', '>', '\n']) {
            Err(format!("{email:?} cannot be a git user.email"))?;
        }
        Ok(Self(email.to_owned()))
    }
}

impl<'de> Deserialize<'de> for Identity {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer)?.parse().map_err(|error| serde::de::Error::custom(format!("{error:?}")))
    }
}

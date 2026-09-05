use std::fmt;

use serde::{Deserialize, Serialize};

// TODO-someday(joel): rename to "user" or "email"?
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Identity(pub String);

impl From<String> for Identity {
    fn from(s: String) -> Self { Self(s) }
}

impl AsRef<str> for Identity {
    fn as_ref(&self) -> &str { &self.0 }
}

impl fmt::Display for Identity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(&self.0) }
}

use std::{fmt, str::FromStr};

use cabaret_types::{ChangeId, Error, Result};
use jiff::{Timestamp, Zoned, fmt::strtime, tz::TimeZone};

use crate::Setting;

/// Prepended to the id of each change you create, so ids you pick need only be unique among
/// yours. Its strftime escapes (`%Y`, `%m`, `%d`, …) expand to the time the change is created.
/// Unset, it defaults to the date; set empty, ids are just their names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prefix(String);

impl Default for Prefix {
    fn default() -> Self { Self("%Y-%m-%d-".to_owned()) }
}

impl Prefix {
    /// The id of a change named `name` created at `now`.
    pub fn apply(&self, name: &str, now: &Zoned) -> Result<ChangeId> {
        Ok(format!("{}{name}", strtime::format(&self.0, now)?).parse()?)
    }
}

impl FromStr for Prefix {
    type Err = Error;

    fn from_str(template: &str) -> Result<Self> {
        let prefix = Self(template.to_owned());
        prefix
            .apply("name", &Timestamp::UNIX_EPOCH.to_zoned(TimeZone::UTC))
            .map_err(|error| format!("{template:?} cannot prefix a change id: {error:?}"))?;
        Ok(prefix)
    }
}

impl fmt::Display for Prefix {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(&self.0) }
}

impl Setting for Prefix {
    const KEY: &'static str = "cabaret.prefix";
}

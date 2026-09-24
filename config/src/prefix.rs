use std::{fmt, str::FromStr};

use cabaret_types::{ChangeId, ChangeIdRef, Error, Result};
use jiff::{Timestamp, Zoned, fmt::strtime, tz::TimeZone};

use crate::Setting;

/// Prepended to the id of each change you create, so ids you pick need only be unique among
/// yours. Its strftime escapes (`%Y`, `%m`, `%d`, …) expand to the time the change is created.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prefix(String);

impl Prefix {
    /// The id of a change named `name` created at `now`.
    pub fn apply(&self, name: &ChangeIdRef, now: &Zoned) -> Result<ChangeId> {
        Ok(format!("{}{name}", strtime::format(&self.0, now)?).parse()?)
    }
}

impl FromStr for Prefix {
    type Err = Error;

    fn from_str(template: &str) -> Result<Self> {
        if template.is_empty() {
            Err("an empty prefix is none; unset it instead")?;
        }
        let prefix = Self(template.to_owned());
        prefix
            .apply(&"name".parse::<ChangeId>()?, &Timestamp::UNIX_EPOCH.to_zoned(TimeZone::UTC))
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

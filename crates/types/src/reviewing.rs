use std::fmt;

use serde::{Deserialize, Serialize};

/// Who a change is up for review by. Owners review every file of their changes; once files carry
/// review obligations of their own, `All` will also ask those obligated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "napi", napi_derive::napi(string_enum = "kebab-case"))]
pub enum Reviewing {
    /// Not yet up for review, as while being written.
    None,
    Owners,
    All,
}

impl Reviewing {
    pub const ALL: &[Self] = &[Self::None, Self::Owners, Self::All];

    pub fn name(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Owners => "owners",
            Self::All => "all",
        }
    }
}

impl fmt::Display for Reviewing {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(self.name()) }
}

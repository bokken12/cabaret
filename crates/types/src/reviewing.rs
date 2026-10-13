use serde::{Deserialize, Serialize};
use strum::{Display, EnumString, VariantNames};

/// Who a change is up for review by. Owners review every file of their changes; once files carry
/// review obligations of their own, `All` will also ask those obligated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Display, EnumString, VariantNames)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
#[cfg_attr(feature = "napi", napi_derive::napi(string_enum = "kebab-case"))]
pub enum Reviewing {
    /// Not yet up for review, as while being written.
    None,
    Owners,
    All,
}

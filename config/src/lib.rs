//! Local state: the user's preferences, kept in git config beside git's own.

mod identity;
mod prefix;
mod setting;

pub use prefix::Prefix;
pub use setting::{Scope, Setting, get, set, unset};

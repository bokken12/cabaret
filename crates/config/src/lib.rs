//! Local state: the user's preferences, kept in git config beside git's own.

mod fetch_interval;
mod hints;
mod identity;
mod prefix;
mod setting;

pub use fetch_interval::FetchInterval;
pub use hints::Hints;
pub use prefix::Prefix;
pub use setting::{Scope, Setting, get, set, unset};

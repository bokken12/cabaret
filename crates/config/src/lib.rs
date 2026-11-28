//! Local state: the user's preferences, kept in git config beside git's own.

mod hints;
mod identity;
mod prefix;
mod setting;
mod sync_interval;

pub use hints::Hints;
pub use prefix::Prefix;
pub use setting::{Scope, Setting, get, set, unset};
pub use sync_interval::SyncInterval;

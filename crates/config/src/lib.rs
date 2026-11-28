//! Local state: the user's preferences and what this repository alone keeps track of, kept in
//! git config beside git's own.

mod forge_cursor;
mod hints;
mod identity;
mod prefix;
mod setting;
mod sync_interval;

pub use forge_cursor::ForgeCursor;
pub use hints::Hints;
pub use prefix::Prefix;
pub use setting::{Scope, Setting, get, set, unset};
pub use sync_interval::SyncInterval;

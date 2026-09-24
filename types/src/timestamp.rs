use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Git's timestamp resolution, as commit times are stored.
pub type TimestampS = gix::date::SecondsSinceUnixEpoch;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TimestampMs(pub u64);

impl TimestampMs {
    pub fn now() -> Self { SystemTime::now().into() }
}

impl From<SystemTime> for TimestampMs {
    fn from(time: SystemTime) -> Self {
        let since_epoch = time.duration_since(UNIX_EPOCH).expect("time is before the Unix epoch");
        Self(u64::try_from(since_epoch.as_millis()).expect("timestamp overflows u64"))
    }
}

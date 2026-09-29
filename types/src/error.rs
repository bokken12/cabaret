use std::{fmt, fmt::Display};

use nonempty_collections::NEVec;

use crate::safeguard::Safeguard;

// TODO(joel): consider including a backtrace for debugging?
pub enum Error {
    /// Safeguards the caller did not allow stopped the action; allowing them lets it go ahead.
    Refused(NEVec<Safeguard>),
    Failed(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl<E: Display> From<E> for Error {
    fn from(message: E) -> Self { Self::Failed(message.to_string()) }
}

impl fmt::Debug for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(refused) => {
                let reasons: Vec<String> = refused.iter().map(ToString::to_string).collect();
                write!(f, "refused: {}", reasons.join("; "))
            }
            Self::Failed(message) => f.write_str(message),
        }
    }
}

#[cfg(feature = "napi")]
impl From<Error> for napi::Error {
    fn from(error: Error) -> Self { Self::from_reason(format!("{error:?}")) }
}

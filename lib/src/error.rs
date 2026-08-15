use std::{fmt, fmt::Display};

pub struct Error(String);

pub type Result<T> = std::result::Result<T, Error>;

impl<E: Display> From<E> for Error {
    fn from(message: E) -> Self { Self(message.to_string()) }
}

impl fmt::Debug for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(&self.0) }
}

#[cfg(feature = "napi")]
impl From<Error> for napi::Error {
    fn from(error: Error) -> Self { Self::from_reason(error.0) }
}

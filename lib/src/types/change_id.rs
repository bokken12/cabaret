use std::{borrow::Borrow, fmt, ops::Deref, str::FromStr};

use gix::{
    bstr::BStr,
    refs::{FullName, PartialName, PartialNameRef},
};
use ref_cast::RefCast;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ChangeId(pub PartialName);

#[derive(PartialEq, Eq, PartialOrd, Ord, RefCast)]
#[repr(transparent)]
pub struct ChangeIdRef(PartialNameRef);

impl Borrow<ChangeIdRef> for ChangeId {
    fn borrow(&self) -> &ChangeIdRef { ChangeIdRef::ref_cast(self.0.as_ref()) }
}

impl AsRef<ChangeIdRef> for ChangeId {
    fn as_ref(&self) -> &ChangeIdRef { self.borrow() }
}

impl Deref for ChangeId {
    type Target = ChangeIdRef;

    fn deref(&self) -> &Self::Target { self.borrow() }
}

impl ToOwned for ChangeIdRef {
    type Owned = ChangeId;

    fn to_owned(&self) -> Self::Owned { ChangeId(self.0.to_owned()) }
}

impl ChangeIdRef {
    pub const LOG_REF_PREFIX: &'static str = "refs/cabaret/changes/";

    pub fn branch_ref(&self) -> FullName {
        FullName::try_from(format!("refs/heads/{self}")).expect("a partial name is valid under refs/heads/")
    }

    pub fn log_ref(&self) -> FullName {
        FullName::try_from(format!("{}{self}", Self::LOG_REF_PREFIX))
            .expect("a partial name is valid under refs/cabaret/changes/")
    }

    pub fn as_bstr(&self) -> &BStr { self.0.as_bstr() }
}

impl fmt::Display for ChangeIdRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { self.0.fmt(f) }
}

impl fmt::Display for ChangeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { fmt::Display::fmt(self.as_ref(), f) }
}

impl fmt::Debug for ChangeIdRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { fmt::Debug::fmt(&self.to_string(), f) }
}

impl fmt::Debug for ChangeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { fmt::Debug::fmt(self.as_ref(), f) }
}

impl FromStr for ChangeId {
    type Err = gix::refs::name::Error;

    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> { PartialName::try_from(s).map(Self) }
}

impl Serialize for ChangeIdRef {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl Serialize for ChangeId {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        self.as_ref().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ChangeId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        String::deserialize(deserializer)?.parse().map_err(serde::de::Error::custom)
    }
}

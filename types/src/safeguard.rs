//! Safeguards: checks that refuse an action unless the caller allows it anyway. Each action
//! names the safeguards it checks in its own types, which widen into [`Safeguard`] for frontends
//! that treat every action alike.

use std::{collections::BTreeSet, fmt};

use nonempty_collections::{NEBTreeSet, NEVec};

use crate::{
    error::{Error, Result},
    identity::Identity,
};

/// `a, b, c`.
fn joined<'a>(identities: impl IntoIterator<Item = &'a Identity>) -> String {
    identities.into_iter().map(ToString::to_string).collect::<Vec<_>>().join(", ")
}

/// A safeguard without its particulars, as frontends name one to allow it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[cfg_attr(feature = "napi", napi_derive::napi(string_enum = "kebab-case"))]
pub enum SafeguardKind {
    Unreviewed,
    NonOwner,
}

impl fmt::Display for SafeguardKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Unreviewed => "unreviewed",
            Self::NonOwner => "non-owner",
        })
    }
}

/// Owners have files of the change left to review.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unreviewed {
    pub reviewers: NEBTreeSet<Identity>,
}

impl fmt::Display for Unreviewed {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let verb = if self.reviewers.len().get() == 1 { "has" } else { "have" };
        write!(f, "{} {verb} files left to review", joined(&self.reviewers))
    }
}

/// You do not own the change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NonOwner {
    pub you: Identity,
    pub owners: BTreeSet<Identity>,
}

impl fmt::Display for NonOwner {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.owners.is_empty() {
            true => write!(f, "you ({}) are not an owner (it has no owners)", self.you),
            false => write!(f, "you ({}) are not an owner (owners: {})", self.you, joined(&self.owners)),
        }
    }
}

/// Any action's safeguard.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Safeguard {
    Unreviewed(Unreviewed),
    NonOwner(NonOwner),
}

impl Safeguard {
    pub fn kind(&self) -> SafeguardKind {
        match self {
            Self::Unreviewed(_) => SafeguardKind::Unreviewed,
            Self::NonOwner(_) => SafeguardKind::NonOwner,
        }
    }
}

impl fmt::Display for Safeguard {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreviewed(unreviewed) => unreviewed.fmt(f),
            Self::NonOwner(non_owner) => non_owner.fmt(f),
        }
    }
}

/// The safeguards of `Cabaret::land`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LandSafeguard {
    Unreviewed(Unreviewed),
    NonOwner(NonOwner),
}

impl From<LandSafeguard> for Safeguard {
    fn from(safeguard: LandSafeguard) -> Self {
        match safeguard {
            LandSafeguard::Unreviewed(unreviewed) => Self::Unreviewed(unreviewed),
            LandSafeguard::NonOwner(non_owner) => Self::NonOwner(non_owner),
        }
    }
}

/// Which [`LandSafeguard`]s to land despite.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LandAllow {
    pub unreviewed: bool,
    pub non_owner: bool,
}

impl LandAllow {
    pub fn refused(self, safeguards: Vec<LandSafeguard>) -> Option<NEVec<LandSafeguard>> {
        NEVec::try_from_vec(safeguards.into_iter().filter(|safeguard| !self.allows(safeguard)).collect())
    }

    fn allows(self, safeguard: &LandSafeguard) -> bool {
        match safeguard {
            LandSafeguard::Unreviewed(_) => self.unreviewed,
            LandSafeguard::NonOwner(_) => self.non_owner,
        }
    }
}

impl From<&[SafeguardKind]> for LandAllow {
    fn from(kinds: &[SafeguardKind]) -> Self {
        let mut allow = Self::default();
        for kind in kinds {
            match kind {
                SafeguardKind::Unreviewed => allow.unreviewed = true,
                SafeguardKind::NonOwner => allow.non_owner = true,
            }
        }
        allow
    }
}

/// The safeguards of `Cabaret::rebase`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RebaseSafeguard {
    NonOwner(NonOwner),
}

impl From<RebaseSafeguard> for Safeguard {
    fn from(safeguard: RebaseSafeguard) -> Self {
        match safeguard {
            RebaseSafeguard::NonOwner(non_owner) => Self::NonOwner(non_owner),
        }
    }
}

/// Which [`RebaseSafeguard`]s to rebase despite.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RebaseAllow {
    pub non_owner: bool,
}

impl RebaseAllow {
    pub fn refused(self, safeguards: Vec<RebaseSafeguard>) -> Option<NEVec<RebaseSafeguard>> {
        NEVec::try_from_vec(safeguards.into_iter().filter(|safeguard| !self.allows(safeguard)).collect())
    }

    fn allows(self, safeguard: &RebaseSafeguard) -> bool {
        match safeguard {
            RebaseSafeguard::NonOwner(_) => self.non_owner,
        }
    }
}

impl TryFrom<&[SafeguardKind]> for RebaseAllow {
    type Error = Error;

    fn try_from(kinds: &[SafeguardKind]) -> Result<Self> {
        let mut allow = Self::default();
        for kind in kinds {
            match kind {
                SafeguardKind::Unreviewed => Err(format!("rebasing has no {kind} safeguard"))?,
                SafeguardKind::NonOwner => allow.non_owner = true,
            }
        }
        Ok(allow)
    }
}

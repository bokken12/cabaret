//! Safeguards: checks that refuse an action unless the caller allows it anyway. Each action
//! names the safeguards it checks in its own types, which widen into [`Safeguard`] for frontends
//! that treat every action alike.

use std::{collections::BTreeSet, fmt};

use nonempty_collections::{NEBTreeSet, NEVec};

use crate::{
    error::{Error, Result},
    identity::Identity,
};

/// Declares every safeguard, each named by the struct holding its particulars: [`Safeguard`]
/// holding any of them, and [`SafeguardKind`] naming one as frontends do to allow it.
macro_rules! every_safeguard {
    ($($kind:ident = $name:literal),+ $(,)?) => {
        /// A safeguard without its particulars, as frontends name one to allow it.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
        #[cfg_attr(feature = "napi", napi_derive::napi(string_enum = "kebab-case"))]
        pub enum SafeguardKind {
            $($kind),+
        }

        impl fmt::Display for SafeguardKind {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(match self {
                    $(Self::$kind => $name),+
                })
            }
        }

        /// Any action's safeguard.
        #[derive(Debug, Clone, PartialEq, Eq)]
        pub enum Safeguard {
            $($kind($kind)),+
        }

        impl Safeguard {
            pub fn kind(&self) -> SafeguardKind {
                match self {
                    $(Self::$kind(_) => SafeguardKind::$kind),+
                }
            }
        }

        impl fmt::Display for Safeguard {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                match self {
                    $(Self::$kind(particulars) => particulars.fmt(f)),+
                }
            }
        }
    };
}

/// Declares the safeguards `$verb` checks: an enum of them, widening into [`Safeguard`], and a
/// struct of which to allow, with a field for each.
macro_rules! safeguards {
    ($verb:literal, $safeguard:ident, $allow:ident { $($kind:ident: $field:ident),+ $(,)? }) => {
        #[doc = concat!("The safeguards checked before you ", $verb, ".")]
        #[derive(Debug, Clone, PartialEq, Eq)]
        pub enum $safeguard {
            $($kind($kind)),+
        }

        impl From<$safeguard> for Safeguard {
            fn from(safeguard: $safeguard) -> Self {
                match safeguard {
                    $($safeguard::$kind(particulars) => Self::$kind(particulars)),+
                }
            }
        }

        #[doc = concat!("Which [`", stringify!($safeguard), "`]s to ", $verb, " despite.")]
        #[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
        pub struct $allow {
            $(pub $field: bool),+
        }

        impl $allow {
            /// Those of `safeguards` not allowed, which refuse the action.
            pub fn refused(self, safeguards: Vec<$safeguard>) -> Option<NEVec<$safeguard>> {
                NEVec::try_from_vec(safeguards.into_iter().filter(|safeguard| !self.allows(safeguard)).collect())
            }

            fn allows(self, safeguard: &$safeguard) -> bool {
                match safeguard {
                    $($safeguard::$kind(_) => self.$field),+
                }
            }
        }

        impl TryFrom<&[SafeguardKind]> for $allow {
            type Error = Error;

            fn try_from(kinds: &[SafeguardKind]) -> Result<Self> {
                let mut allow = Self::default();
                for kind in kinds {
                    match kind {
                        $(SafeguardKind::$kind => allow.$field = true,)+
                        #[allow(unreachable_patterns)]
                        other => Err(format!("nothing to allow: {other} is not checked before you {}", $verb))?,
                    }
                }
                Ok(allow)
            }
        }
    };
}

every_safeguard! {
    Unreviewed = "unreviewed",
    NonOwner = "non-owner",
}

safeguards!("land", LandSafeguard, LandAllow { Unreviewed: unreviewed, NonOwner: non_owner });
safeguards!("rebase", RebaseSafeguard, RebaseAllow { NonOwner: non_owner });

/// `a, b, c`.
fn joined<'a>(identities: impl IntoIterator<Item = &'a Identity>) -> String {
    identities.into_iter().map(ToString::to_string).collect::<Vec<_>>().join(", ")
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

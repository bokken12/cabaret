//! Safeguards: checks that refuse an action unless the caller allows it anyway.

use std::{collections::BTreeSet, fmt};

use nonempty_collections::{NEBTreeSet, NEVec};

use crate::{
    change_id::ChangeId,
    error::{Error, Result},
    identity::Identity,
    repo_path::RepoPath,
    workspace_id::WorkspaceId,
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

        impl SafeguardKind {
            pub const ALL: &[Self] = &[$(Self::$kind),+];

            pub fn name(self) -> &'static str {
                match self {
                    $(Self::$kind => $name),+
                }
            }
        }

        impl fmt::Display for SafeguardKind {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(self.name()) }
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

every_safeguard! {
    Unreviewed = "unreviewed",
    NonOwner = "non-owner",
    ParentUnreviewed = "parent-unreviewed",
    Empty = "empty",
    Conflicted = "conflicted",
    Uncommitted = "uncommitted",
    ParentConflicted = "parent-conflicted",
    RemovesOthers = "removes-others",
    Ownerless = "ownerless",
    BaseMoves = "base-moves",
    Parentless = "parentless",
    NoCommonAncestor = "no-common-ancestor",
    ArchivedParent = "archived-parent",
    RedundantParent = "redundant-parent",
    ImpermanentParents = "impermanent-parents",
    OpenChildren = "open-children",
    Permanent = "permanent",
    ArchivedParents = "archived-parents",
}

/// The kinds of safeguard the caller allows, letting the action go ahead despite them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Allow(BTreeSet<SafeguardKind>);

impl Allow {
    pub fn allows(&self, kind: SafeguardKind) -> bool { self.0.contains(&kind) }

    /// Refuse the action if any of `safeguards` is not allowed.
    pub fn check(&self, safeguards: Vec<Safeguard>) -> Result<()> {
        let refused = safeguards.into_iter().filter(|safeguard| !self.allows(safeguard.kind())).collect();
        match NEVec::try_from_vec(refused) {
            Some(refused) => Err(Error::Refused(refused)),
            None => Ok(()),
        }
    }
}

impl FromIterator<SafeguardKind> for Allow {
    fn from_iter<I: IntoIterator<Item = SafeguardKind>>(kinds: I) -> Self { Self(kinds.into_iter().collect()) }
}

/// `a, b, c`.
fn joined(items: impl IntoIterator<Item: fmt::Display>) -> String {
    items.into_iter().map(|item| item.to_string()).collect::<Vec<_>>().join(", ")
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

/// Owners of the parent have files of it left to review, which landing would bury in its diff.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParentUnreviewed {
    pub parent: ChangeId,
    pub reviewers: NEBTreeSet<Identity>,
}

impl fmt::Display for ParentUnreviewed {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let verb = if self.reviewers.len().get() == 1 { "has" } else { "have" };
        write!(f, "{} {verb} files of {} left to review", joined(&self.reviewers), self.parent)
    }
}

/// The change adds nothing to its parent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Empty {
    pub parent: ChangeId,
}

impl fmt::Display for Empty {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "it adds nothing to {}", self.parent) }
}

/// Files would be left holding conflict markers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conflicted {
    pub files: NEBTreeSet<RepoPath>,
}

impl fmt::Display for Conflicted {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "conflicts in {}", joined(&self.files)) }
}

/// A workspace has changes not yet committed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Uncommitted {
    pub workspace: WorkspaceId,
}

impl fmt::Display for Uncommitted {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "workspace {} has uncommitted changes", self.workspace)
    }
}

/// A parent to be merged in holds conflict markers, which would come along.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParentConflicted {
    pub parent: ChangeId,
    pub files: NEBTreeSet<RepoPath>,
}

impl fmt::Display for ParentConflicted {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} has conflicts in {}", self.parent, joined(&self.files))
    }
}

/// Owners other than you would be removed, and may lose track of the change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemovesOthers {
    pub owners: NEBTreeSet<Identity>,
}

impl fmt::Display for RemovesOthers {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} would no longer own it", joined(&self.owners))
    }
}

/// The change would be left with no owners to shepherd it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ownerless;

impl fmt::Display for Ownerless {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str("it would have no owners") }
}

/// Removing a parent moves the change's base back, taking the parent's work into its diff.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BaseMoves {
    pub removed: ChangeId,
}

impl fmt::Display for BaseMoves {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "its diff would take in the work of {}", self.removed)
    }
}

/// The change would be left with no parent to land into.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parentless;

impl fmt::Display for Parentless {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str("it would have nowhere to land") }
}

/// The change's parents share no ancestor, so they could never coalesce into one to land into.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoCommonAncestor {
    pub parents: NEBTreeSet<ChangeId>,
}

impl fmt::Display for NoCommonAncestor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} share no ancestor, so it could never land", joined(&self.parents))
    }
}

/// An archived parent, which working out the change's parents skips.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchivedParent {
    pub parent: ChangeId,
}

impl fmt::Display for ArchivedParent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} is archived, so it would be skipped", self.parent)
    }
}

/// A parent that is already an ancestor of another, which working out the change's parents skips.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedundantParent {
    pub parent: ChangeId,
    pub descendant: ChangeId,
}

impl fmt::Display for RedundantParent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} is already an ancestor of {}, so it would be skipped", self.parent, self.descendant)
    }
}

/// Parents that will land and be archived, leaving a permanent change nowhere lasting to land.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImpermanentParents {
    pub parents: NEBTreeSet<ChangeId>,
}

impl fmt::Display for ImpermanentParents {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let verb = if self.parents.len().get() == 1 { "is" } else { "are" };
        write!(f, "{} {verb} not permanent", joined(&self.parents))
    }
}

/// Open changes still land into the change, and would move to land past it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenChildren {
    pub children: NEBTreeSet<ChangeId>,
}

impl fmt::Display for OpenChildren {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let verb = if self.children.len().get() == 1 { "lands" } else { "land" };
        write!(f, "{} still {verb} into it", joined(&self.children))
    }
}

/// The change was marked permanent, meant never to be archived.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Permanent;

impl fmt::Display for Permanent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str("it is permanent") }
}

/// Declared parents that are archived, so the change would land past them, taking in their work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchivedParents {
    pub parents: NEBTreeSet<ChangeId>,
}

impl fmt::Display for ArchivedParents {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let verb = if self.parents.len().get() == 1 { "is" } else { "are" };
        write!(f, "{} {verb} archived, so its diff would take in the archived work", joined(&self.parents))
    }
}

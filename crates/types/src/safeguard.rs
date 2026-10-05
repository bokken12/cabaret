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

/// A safeguard without its particulars, as frontends name one to allow it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[cfg_attr(feature = "napi", napi_derive::napi(string_enum = "kebab-case"))]
pub enum SafeguardKind {
    Unreviewed,
    NonOwner,
    ParentUnreviewed,
    Empty,
    Conflicted,
    Uncommitted,
    ParentConflicted,
    RemovesOthers,
    Ownerless,
    BaseMoves,
    Parentless,
    NoCommonAncestor,
    ArchivedParent,
    RedundantParent,
    ImpermanentParents,
    OpenChildren,
    Permanent,
    ArchivedParents,
}

impl SafeguardKind {
    pub const ALL: &[Self] = &[
        Self::Unreviewed,
        Self::NonOwner,
        Self::ParentUnreviewed,
        Self::Empty,
        Self::Conflicted,
        Self::Uncommitted,
        Self::ParentConflicted,
        Self::RemovesOthers,
        Self::Ownerless,
        Self::BaseMoves,
        Self::Parentless,
        Self::NoCommonAncestor,
        Self::ArchivedParent,
        Self::RedundantParent,
        Self::ImpermanentParents,
        Self::OpenChildren,
        Self::Permanent,
        Self::ArchivedParents,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::Unreviewed => "unreviewed",
            Self::NonOwner => "non-owner",
            Self::ParentUnreviewed => "parent-unreviewed",
            Self::Empty => "empty",
            Self::Conflicted => "conflicted",
            Self::Uncommitted => "uncommitted",
            Self::ParentConflicted => "parent-conflicted",
            Self::RemovesOthers => "removes-others",
            Self::Ownerless => "ownerless",
            Self::BaseMoves => "base-moves",
            Self::Parentless => "parentless",
            Self::NoCommonAncestor => "no-common-ancestor",
            Self::ArchivedParent => "archived-parent",
            Self::RedundantParent => "redundant-parent",
            Self::ImpermanentParents => "impermanent-parents",
            Self::OpenChildren => "open-children",
            Self::Permanent => "permanent",
            Self::ArchivedParents => "archived-parents",
        }
    }
}

impl fmt::Display for SafeguardKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(self.name()) }
}

/// Any action's safeguard.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Safeguard {
    Unreviewed(Unreviewed),
    NonOwner(NonOwner),
    ParentUnreviewed(ParentUnreviewed),
    Empty(Empty),
    Conflicted(Conflicted),
    Uncommitted(Uncommitted),
    ParentConflicted(ParentConflicted),
    RemovesOthers(RemovesOthers),
    Ownerless(Ownerless),
    BaseMoves(BaseMoves),
    Parentless(Parentless),
    NoCommonAncestor(NoCommonAncestor),
    ArchivedParent(ArchivedParent),
    RedundantParent(RedundantParent),
    ImpermanentParents(ImpermanentParents),
    OpenChildren(OpenChildren),
    Permanent(Permanent),
    ArchivedParents(ArchivedParents),
}

impl Safeguard {
    pub fn kind(&self) -> SafeguardKind {
        match self {
            Self::Unreviewed(_) => SafeguardKind::Unreviewed,
            Self::NonOwner(_) => SafeguardKind::NonOwner,
            Self::ParentUnreviewed(_) => SafeguardKind::ParentUnreviewed,
            Self::Empty(_) => SafeguardKind::Empty,
            Self::Conflicted(_) => SafeguardKind::Conflicted,
            Self::Uncommitted(_) => SafeguardKind::Uncommitted,
            Self::ParentConflicted(_) => SafeguardKind::ParentConflicted,
            Self::RemovesOthers(_) => SafeguardKind::RemovesOthers,
            Self::Ownerless(_) => SafeguardKind::Ownerless,
            Self::BaseMoves(_) => SafeguardKind::BaseMoves,
            Self::Parentless(_) => SafeguardKind::Parentless,
            Self::NoCommonAncestor(_) => SafeguardKind::NoCommonAncestor,
            Self::ArchivedParent(_) => SafeguardKind::ArchivedParent,
            Self::RedundantParent(_) => SafeguardKind::RedundantParent,
            Self::ImpermanentParents(_) => SafeguardKind::ImpermanentParents,
            Self::OpenChildren(_) => SafeguardKind::OpenChildren,
            Self::Permanent(_) => SafeguardKind::Permanent,
            Self::ArchivedParents(_) => SafeguardKind::ArchivedParents,
        }
    }
}

impl fmt::Display for Safeguard {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreviewed(particulars) => particulars.fmt(f),
            Self::NonOwner(particulars) => particulars.fmt(f),
            Self::ParentUnreviewed(particulars) => particulars.fmt(f),
            Self::Empty(particulars) => particulars.fmt(f),
            Self::Conflicted(particulars) => particulars.fmt(f),
            Self::Uncommitted(particulars) => particulars.fmt(f),
            Self::ParentConflicted(particulars) => particulars.fmt(f),
            Self::RemovesOthers(particulars) => particulars.fmt(f),
            Self::Ownerless(particulars) => particulars.fmt(f),
            Self::BaseMoves(particulars) => particulars.fmt(f),
            Self::Parentless(particulars) => particulars.fmt(f),
            Self::NoCommonAncestor(particulars) => particulars.fmt(f),
            Self::ArchivedParent(particulars) => particulars.fmt(f),
            Self::RedundantParent(particulars) => particulars.fmt(f),
            Self::ImpermanentParents(particulars) => particulars.fmt(f),
            Self::OpenChildren(particulars) => particulars.fmt(f),
            Self::Permanent(particulars) => particulars.fmt(f),
            Self::ArchivedParents(particulars) => particulars.fmt(f),
        }
    }
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

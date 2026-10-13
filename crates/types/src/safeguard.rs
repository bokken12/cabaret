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
    ArchivedParent,
    ArchivedParents,
    BaseMoves,
    Conflicted,
    Empty,
    ImpermanentParents,
    NoCommonAncestor,
    NonOwner,
    OpenChildren,
    Ownerless,
    ParentConflicted,
    Parentless,
    ParentUnreviewed,
    Permanent,
    RedundantParent,
    RemovesOthers,
    Uncommitted,
    Unendorsed,
    Unreviewed,
}

impl SafeguardKind {
    pub const ALL: &[Self] = &[
        Self::ArchivedParent,
        Self::ArchivedParents,
        Self::BaseMoves,
        Self::Conflicted,
        Self::Empty,
        Self::ImpermanentParents,
        Self::NoCommonAncestor,
        Self::NonOwner,
        Self::OpenChildren,
        Self::Ownerless,
        Self::ParentConflicted,
        Self::Parentless,
        Self::ParentUnreviewed,
        Self::Permanent,
        Self::RedundantParent,
        Self::RemovesOthers,
        Self::Uncommitted,
        Self::Unendorsed,
        Self::Unreviewed,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::ArchivedParent => "archived-parent",
            Self::ArchivedParents => "archived-parents",
            Self::BaseMoves => "base-moves",
            Self::Conflicted => "conflicted",
            Self::Empty => "empty",
            Self::ImpermanentParents => "impermanent-parents",
            Self::NoCommonAncestor => "no-common-ancestor",
            Self::NonOwner => "non-owner",
            Self::OpenChildren => "open-children",
            Self::Ownerless => "ownerless",
            Self::ParentConflicted => "parent-conflicted",
            Self::Parentless => "parentless",
            Self::ParentUnreviewed => "parent-unreviewed",
            Self::Permanent => "permanent",
            Self::RedundantParent => "redundant-parent",
            Self::RemovesOthers => "removes-others",
            Self::Uncommitted => "uncommitted",
            Self::Unendorsed => "unendorsed",
            Self::Unreviewed => "unreviewed",
        }
    }
}

impl fmt::Display for SafeguardKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(self.name()) }
}

/// Any action's safeguard.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Safeguard {
    /// An archived parent, which working out the change's parents skips.
    ArchivedParent { parent: ChangeId },
    /// Declared parents that are archived, so the change would land past them, taking in their work.
    ArchivedParents { parents: NEBTreeSet<ChangeId> },
    /// Removing a parent moves the change's base back, taking the parent's work into its diff.
    BaseMoves { removed: ChangeId },
    /// Files would be left holding conflict markers.
    Conflicted { files: NEBTreeSet<RepoPath> },
    /// The change adds nothing to its parent.
    Empty { parent: ChangeId },
    /// Parents that will land and be archived, leaving a permanent change nowhere lasting to land.
    ImpermanentParents { parents: NEBTreeSet<ChangeId> },
    /// The change's parents share no ancestor, so they could never coalesce into one to land into.
    NoCommonAncestor { parents: NEBTreeSet<ChangeId> },
    /// You do not own the change.
    NonOwner { you: Identity, owners: BTreeSet<Identity> },
    /// Open changes still land into the change, and would move to land past it.
    OpenChildren { children: NEBTreeSet<ChangeId> },
    /// The change would be left with no owners to shepherd it.
    Ownerless,
    /// A parent to be merged in holds conflict markers, which would come along.
    ParentConflicted { parent: ChangeId, files: NEBTreeSet<RepoPath> },
    /// The change would be left with no parent to land into.
    Parentless,
    /// Owners of the parent have files of it left to review, which landing would bury in its diff.
    ParentUnreviewed { parent: ChangeId, reviewers: NEBTreeSet<Identity> },
    /// The change was marked permanent, meant never to be archived.
    Permanent,
    /// A parent that is already an ancestor of another, which working out the change's parents skips.
    RedundantParent { parent: ChangeId, descendant: ChangeId },
    /// Owners other than you would be removed, and may lose track of the change.
    RemovesOthers { owners: NEBTreeSet<Identity> },
    /// A workspace has changes not yet committed.
    Uncommitted { workspace: WorkspaceId },
    /// Owners have not endorsed the change.
    Unendorsed { owners: NEBTreeSet<Identity> },
    /// Owners have files of the change left to review.
    Unreviewed { reviewers: NEBTreeSet<Identity> },
}

impl Safeguard {
    pub fn kind(&self) -> SafeguardKind {
        match self {
            Self::ArchivedParent { .. } => SafeguardKind::ArchivedParent,
            Self::ArchivedParents { .. } => SafeguardKind::ArchivedParents,
            Self::BaseMoves { .. } => SafeguardKind::BaseMoves,
            Self::Conflicted { .. } => SafeguardKind::Conflicted,
            Self::Empty { .. } => SafeguardKind::Empty,
            Self::ImpermanentParents { .. } => SafeguardKind::ImpermanentParents,
            Self::NoCommonAncestor { .. } => SafeguardKind::NoCommonAncestor,
            Self::NonOwner { .. } => SafeguardKind::NonOwner,
            Self::OpenChildren { .. } => SafeguardKind::OpenChildren,
            Self::Ownerless => SafeguardKind::Ownerless,
            Self::ParentConflicted { .. } => SafeguardKind::ParentConflicted,
            Self::Parentless => SafeguardKind::Parentless,
            Self::ParentUnreviewed { .. } => SafeguardKind::ParentUnreviewed,
            Self::Permanent => SafeguardKind::Permanent,
            Self::RedundantParent { .. } => SafeguardKind::RedundantParent,
            Self::RemovesOthers { .. } => SafeguardKind::RemovesOthers,
            Self::Uncommitted { .. } => SafeguardKind::Uncommitted,
            Self::Unendorsed { .. } => SafeguardKind::Unendorsed,
            Self::Unreviewed { .. } => SafeguardKind::Unreviewed,
        }
    }
}

impl fmt::Display for Safeguard {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ArchivedParent { parent } => write!(f, "{parent} is archived, so it would be skipped"),
            Self::ArchivedParents { parents } => {
                let verb = if parents.len().get() == 1 { "is" } else { "are" };
                write!(f, "{} {verb} archived, so its diff would take in the archived work", joined(parents))
            }
            Self::BaseMoves { removed } => write!(f, "its diff would take in the work of {removed}"),
            Self::Conflicted { files } => write!(f, "conflicts in {}", joined(files)),
            Self::Empty { parent } => write!(f, "it adds nothing to {parent}"),
            Self::ImpermanentParents { parents } => {
                let verb = if parents.len().get() == 1 { "is" } else { "are" };
                write!(f, "{} {verb} not permanent", joined(parents))
            }
            Self::NoCommonAncestor { parents } => {
                write!(f, "{} share no ancestor, so it could never land", joined(parents))
            }
            Self::NonOwner { you, owners } => match owners.is_empty() {
                true => write!(f, "you ({you}) are not an owner (it has no owners)"),
                false => write!(f, "you ({you}) are not an owner (owners: {})", joined(owners)),
            },
            Self::OpenChildren { children } => {
                let verb = if children.len().get() == 1 { "lands" } else { "land" };
                write!(f, "{} still {verb} into it", joined(children))
            }
            Self::Ownerless => f.write_str("it would have no owners"),
            Self::ParentConflicted { parent, files } => write!(f, "{parent} has conflicts in {}", joined(files)),
            Self::Parentless => f.write_str("it would have nowhere to land"),
            Self::ParentUnreviewed { parent, reviewers } => {
                let verb = if reviewers.len().get() == 1 { "has" } else { "have" };
                write!(f, "{} {verb} files of {parent} left to review", joined(reviewers))
            }
            Self::Permanent => f.write_str("it is permanent"),
            Self::RedundantParent { parent, descendant } => {
                write!(f, "{parent} is already an ancestor of {descendant}, so it would be skipped")
            }
            Self::RemovesOthers { owners } => write!(f, "{} would no longer own it", joined(owners)),
            Self::Uncommitted { workspace } => write!(f, "workspace {workspace} has uncommitted changes"),
            Self::Unendorsed { owners } => {
                let verb = if owners.len().get() == 1 { "has" } else { "have" };
                write!(f, "{} {verb} not endorsed it", joined(owners))
            }
            Self::Unreviewed { reviewers } => {
                let verb = if reviewers.len().get() == 1 { "has" } else { "have" };
                write!(f, "{} {verb} files left to review", joined(reviewers))
            }
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

//! Safeguards: checks that refuse an action unless the caller allows it anyway.

use std::{collections::BTreeSet, fmt};

use nonempty_collections::{NEBTreeSet, NEVec};
use strum::{Display, EnumDiscriminants, EnumString, VariantNames};

use crate::{
    change_id::ChangeId,
    error::{Error, Result},
    identity::Identity,
    repo_path::RepoPath,
    workspace_id::WorkspaceId,
};

/// Any action's safeguard.
#[derive(Debug, Clone, PartialEq, Eq, EnumDiscriminants)]
#[strum_discriminants(
    name(SafeguardKind),
    doc = "A safeguard without its particulars, as frontends name one to allow it.",
    derive(PartialOrd, Ord, Display, EnumString, VariantNames),
    strum(serialize_all = "kebab-case"),
    cfg_attr(feature = "napi", napi_derive::napi(string_enum = "kebab-case"))
)]
pub enum Safeguard {
    /// Archived parent of a non-archived change (parent would be included in diff)
    ArchivedParents { parents: NEBTreeSet<ChangeId> },
    // TODO(joel for claude): `removed: NEBTreeSet<ChangeId>` will be necessary for `cab parents set`
    /// Removing a parent moves the change's base back (parent would be included in diff)
    BaseMoves { removed: ChangeId },
    /// Files would be left holding conflict markers.
    Conflicted { files: NEBTreeSet<RepoPath> },
    /// The change adds nothing to its parent.
    Empty { parent: ChangeId },
    /// Parents that will land and be archived, leaving a permanent change nowhere lasting to land.
    ImpermanentParents { parents: NEBTreeSet<ChangeId> },
    // TODO-someday(joel): perhaps this should be made impossible by inserting a trivial ancestor?
    /// The change's parents share no ancestor, so they could never coalesce into one to land into.
    NoCommonAncestor { parents: NEBTreeSet<ChangeId> },
    /// You do not own the change.
    NonOwner { you: Identity, owners: BTreeSet<Identity> },
    /// A parent should not be archived while its children are still open
    OpenChildren { children: NEBTreeSet<ChangeId> },
    /// The change would be left with no owners to shepherd it.
    Ownerless,
    /// A parent to be merged in holds conflict markers, which would come along.
    ParentConflicted { parent: ChangeId, files: NEBTreeSet<RepoPath> },
    /// The change would be left with no parent to land into.
    Parentless,
    /// Parent has outstanding review obligations, such that landing would duplicate review
    ParentUnreviewed { parent: ChangeId, reviewers: NEBTreeSet<Identity> },
    /// The change was marked permanent, meant never to be archived.
    Permanent,
    // TODO(joel for claude): make this the dominating and dominated `NEBTreeSet`s?
    /// Adding a parent that is already an ancestor of another
    RedundantParent { parent: ChangeId, descendant: ChangeId },
    /// Owners other than you would be removed, and may lose track of the change.
    RemovesOthers { owners: NEBTreeSet<Identity> },
    /// A workspace has changes not yet committed, which deleting it would forget.
    Uncommitted { workspace: WorkspaceId },
    /// Owners have not endorsed the change, so it is not ready to land.
    Unendorsed { owners: NEBTreeSet<Identity> },
    /// Review obligations have not been satisfied, so it is not ready to land.
    Unreviewed { reviewers: NEBTreeSet<Identity> },
}

/// `a, b, c`.
fn joined(items: impl IntoIterator<Item: fmt::Display>) -> String {
    items.into_iter().map(|item| item.to_string()).collect::<Vec<_>>().join(", ")
}

impl fmt::Display for Safeguard {
    // TODO-someday(joel): maybe remove all theverb complexity and just write things like
    // "owners not yet endorsed: {owners}" regardless of plurality
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ArchivedParents { parents } => {
                let verb = if parents.len().get() == 1 { "is" } else { "are" };
                write!(f, "{} {verb} archived, so should not have unarchived children", joined(parents))
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
        let refused = safeguards.into_iter().filter(|safeguard| !self.allows(SafeguardKind::from(safeguard))).collect();
        match NEVec::try_from_vec(refused) {
            Some(refused) => Err(Error::Refused(refused)),
            None => Ok(()),
        }
    }
}

impl FromIterator<SafeguardKind> for Allow {
    fn from_iter<I: IntoIterator<Item = SafeguardKind>>(kinds: I) -> Self { Self(kinds.into_iter().collect()) }
}

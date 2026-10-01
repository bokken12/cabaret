# Branches

How should Cabaret changes relate to git branches? Should a branch always imply a change? Should a change always imply a branch? Can there be a single source of truth even when storing Cabaret's log necessitates an extra ref?

## Normal Operations

For a typical Cabaret user, a change will correspond 1:1 with a branch. They will `cab create` the branch at its parent's tip and the metadata with the appropriate parent and title at the same time. They will operate on the change, committing to its branch and updating the metadata ref depending on the kind of operation they wish to perform, until the change is archived, at which point both refs can be deleted.

## Branch Without Metadata

Branches without metadata are nonetheless a common occurrence, particularly because Cabaret users work together with ordinary git users who create branches. In these cases, should the branch be considered a kind of degenerate empty-metadata change, or not be a change at all? In the process of working with ordinary git users, a Cabaret user may e.g. want to create a change whose parent is an ordinary branch. That means either this must be promoted to a change, or parents must be allowed to be non-changes? Another relevant case to note, is that Cabaret users will want to be able to review others' branches, at least when they become pull requests or similar, at which point they will need metadata.

## Metadata Without Branch

It is also possible, if rarer, that metadata could exist without a corresponding branch. This could happen if a git user manually deletes the branch which corresponded to a change. In these cases, should the change be considered archived or broken? Should it record commits in the metadata to recover?

## Options

In general, the question of metadata without branches seems unimportant, but the former question seems important. The first decision seems to be "when should a branch be adopted as a Cabaret change", with possible options including:

1. A branch is always implicitly a Cabaret change and so has no explicit adoption step.
2. A branch is automatically adopted as a Cabaret change when a GitHub or similar forge request is created for it, giving it metadata.
3. A branch must be explicitly adopted by a Cabaret user.

The last of these options feels somewhat bad, while the former two feel pretty similar in outcome: since in either case other people's changes would not really start showing up in your home page or similar until they were ready for review.

Overall I lean towards 1 as cleaner, with the assumption that changes from other users will be fairly bare until they sync from forge metadata. In particular, they will lack parents, which prevents any review from being performed on them, but this makes sense pre-PR.



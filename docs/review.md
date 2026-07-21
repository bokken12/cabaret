# Review


## State

For each change x user, review state can be represented as a map of

> file name -> (base revision, tip revision, timestamp)

representing the latest diff they have reviewed for each file in the change.


## Visualization

To determine what diff to show a user for a file, we compare their saved base and tip to the change's current base and tip.

### No Prior Review

If there exists no previous review state, we can simply show the change's base->tip diff.

### Same Base

If the change and the prior review state have the same base, we show the diff between tips.

### Different Base

If the change and prior review state have different bases, we must show a ddiff/diff4 between the current and reviewed diffs.


## Transitions

How do different actions affect this?

### Review

When a user marks a file as reviewed, its state is set to the current base/tip, after which no diff remains.

### Commit

When a new commit is added to a change, the change's tip moves, creating a diff for reviewers.

### Rebase

When a change is rebased, its base and tip both move, but its ddiff does not change outside of conflicts.

### Land

When a child change is landed into its parent, their review states must be considered together. The following cases apply per user as assessed against all of their file review collectively so that a single change's review stays together rather than being split.

#### Parent & Child Both Reviewed

Upon landing, the parent review state tips are fast-forwarded to the landed tip, since the diff was reviewed in the child. This matches the normal release process, which requires review in the parent and child to be completed.

#### Parent & Child Both Unreviewed

Upon landing, the child review states are fast-forwarded to completion, since its diff will be read combined with the parent diff. Can occur when bypassing review, and common for non-blocking follow review. Will compress stacks to a single readable diff to catch up on.

#### Parent Reviewed, Child Unreviewed

The unique case where fast-forwarding either the parent or the child produces reasonable semantics. We choose to fast-forward the parent, leaving remaining follow review in the child so review does not all accumulate on the trunk.

#### Parent Unreviewed, Child Reviewed

The failure case, where non-duplicative review would need to split into two "spans" before and after the land. We make no affordances, and allow for the child's review to be duplicated in the parent. Instead, we structurally discourage this on both ends, requiring the parent to be reviewed before release and requiring review in the parent before review in the child (which also makes sense chronologically).


## Exceptions

### Moves & Copies

Cabaret will opportunistically attempt to identify when files are moved or copied and display them as such in order to minimize the reviewable diff. However it makes no particular promises to succeed at this.

### Forge Integration

Most forges do not do diff-based review, but instead ask for a single "approval". To faithfully represent that when syncing from a forge, this sort of approval creates a special state wherein the user is always considered to have reviewed the change no matter how it evolves.

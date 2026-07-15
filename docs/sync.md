# Syncing

Which reading of a branch to trust, when refs move on their own, and when the
user must resolve divergence before an operation.

## Two algebras

A change's log merges by union: any two copies combine automatically,
losslessly, and identically on every machine, so log divergence is a
non-event and logs sync maximally eagerly — fetched, merged, and pushed
whenever we touch the network.

A branch is a register: fast-forward is the only automatic move, and
divergence needs a decision from a human. Cabaret observes, annotates, and
nudges; it never resolves branch divergence itself.

## Local vs origin readings

A local branch records the user's working position; it is not evidence about
a change. Facts about a change — its base, its staleness, a rebase target —
derive from the freshest reading of each branch available, local or
last-fetched origin. A merge-base against a too-new parent is harmless (it
cannot reach past what the change's history contains), while one against a
stale parent absorbs whatever landed in between: staleness is the only
failure mode, so take the descendant-most reading. With no origin this
degrades to the local reading alone.

When readings of the parent diverge, the change's own history arbitrates:
every base candidate (the stored set-base, the merge-base against each
reading) is an ancestor of the tip, and the base is the unique maximal
candidate under the ancestor order. If none dominates, the change merged
unrelated lines and the user declares a base by rebasing.

## Eagerness

Fetching is free: logs and remote-tracking refs update in the background;
views render local state immediately, never block on the network, and
refresh when a fetch lands. A local branch strictly behind origin
fast-forwards automatically unless it is checked out — background work never
touches the worktree. Pushing a branch publishes code and stays explicit;
appending to the log already was the publishing act, so log pushes ride
along with every sync.

A log may name revisions this clone has not fetched — writers update branch
and log non-atomically, so no sync discipline prevents it. Every read
tolerates an unknown revision, rendering it as unfetched rather than
failing, and log sync never waits on branch sync.

## Forcing resolution

Reads never require unification; writes fail fast on a reading the user
should reconcile first. Operating on a change behind or diverged from origin
nudges "pull first", with an --even-though escape hatch; an ambiguous base
demands a rebase. Divergence of the change itself belongs to its owner — an
intentional rewrite pushes with lease, an accidental one resets to origin —
while a diverged parent usually means stray local commits, annotated on the
pages that read it.

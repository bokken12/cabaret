# Syncing

How cabaret picks between local and origin readings of a branch, when it
moves refs on its own, and when the user must resolve divergence first.

## Two algebras

- Logs merge by union: any two copies combine automatically and identically
  on every machine. Divergence is a non-event, so logs sync eagerly — fetch,
  merge, and push whenever we touch the network.
- Branches only fast-forward automatically. Cabaret surfaces branch
  divergence but never resolves it itself.

## Local vs origin readings

A local branch is the user's working position, not evidence about a change.
Facts about a change — base, staleness, rebase target — use the freshest
reading of each branch: the descendant-most of local and last-fetched
origin. A merge-base against a too-new parent is harmless (it cannot reach
past the change's own history); against a stale parent it absorbs whatever
landed in between. With no origin, the local reading is all there is.

When parent readings diverge, the change's history arbitrates: every base
candidate (stored set-base, merge-base against each reading) is an ancestor
of the tip, and the base is the unique maximal candidate under ancestor
order. If none dominates, the change merged unrelated lines; the user
declares a base by rebasing.

## Eagerness

- Fetch in the background: logs, remote-tracking refs, and fast-forwards of
  local branches that are not checked out. Background work never touches the
  worktree.
- Views render local state immediately and refresh when a fetch lands; they
  never block on the network.
- Pushing a branch publishes code and stays explicit. Log entries were
  published when appended, so log pushes ride along with every sync.
- A log may name revisions this clone has not fetched; branch and log update
  non-atomically, so no discipline prevents it. Reads render unknown
  revisions as unfetched instead of failing, and log sync never waits on
  branch sync.

## Forcing resolution

Reads never require unification. Writes fail fast on state the user should
reconcile: a change behind or diverged from origin nudges "pull first" (with
an --even-though escape hatch); an ambiguous base demands a rebase.
Divergence of the change itself is the owner's — an intentional rewrite
pushes with lease, an accidental one resets to origin. A diverged parent
usually means stray local commits, and is noted on the pages that read it.

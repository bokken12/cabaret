# Syncing

How cabaret converges local, origin, and forge state, and the few moments
that ask for a person.

## One algebra

Everything cabaret shares is append-only, so any two copies of a thing have
a join, and convergence never needs a direction:

- Logs merge by union: any two copies combine automatically and identically
  on every machine. Divergence is a non-event.
- Branches only ever gain descendants — rebase and land are merges, never
  rewrites — so local and origin copies of a branch share their history and
  merge like any two lines of work. Commits are substrate, not a story:
  nothing about a committed revision is provisional, so nothing about one
  needs curating before it travels.

Push and pull are therefore not distinct operations, just transport.

## Replication and attention

Because joins always exist, replication needs no consent: everything
shared moves as soon as transport allows. A command that appends to a log
carries its own append out — pushing the log and settling the forge
change on its way — so shared state moves at the speed of the mutation,
with the ambient sweep as the retry loop. Every fetch unions logs both
ways, pushes branch advances, fast-forwards branches whose moves lose
nothing, commits clean joins, and reconciles forge changes in both
directions. Replication is not publication in any social sense — attention
is carried entirely by the reviewing state, and nothing ambient ever mints
it. Nor does anything ambient mint work: a dirty workspace's tree holds
put, and a join that would conflict is left for the user.

A person enters in exactly three places:

- Reviewing — the attention act: inviting, widening, or ending review.
- `sync` — consent to work: join this change's diverged readings now,
  committing conflict markers (the fix-conflicts state) for the user to
  resolve. Explicit because it may touch a working tree and hands the user
  the conflicts it creates, not because anything about it publishes.
- `land` — the one directional act. Replication carries no intent; landing
  is intent, and it is the single linearization point (a forge land
  compare-and-swaps on the head; a local land CASes the parent ref) that
  lets everything else be eventually consistent.

`fetch` is the ambient sweep that runs all replication — what background
sync executes on a short cadence, and never a thing a user must think
about.

## Joins

A branch's two readings converge by descent whenever possible: an idle
branch fast-forwards invisibly, a clean workspace's tree follows the line
of work it already sits on, and a dirty workspace holds its branch put.
When readings genuinely diverge, the join is a merge:

- A clean join — one that merges without conflicts — commits ambiently
  during fetch, except into a branch held by a dirty workspace, which
  waits. Machine-authored merge commits are ordinary substrate.
- A conflicted join is never attempted ambiently: the change is nudged for
  `sync`, and the pair of diverged readings is not reconsidered until one
  of them moves — there is nothing to retry into. Sync commits the
  conflict markers and leaves the change in the fix-conflicts state.

Out-of-band rewrites merge with their own past the same way.

## Local vs origin readings

A local branch is the user's working position, not evidence about a change.
Facts about a change — base, staleness, rebase target — use the freshest
reading of each branch: the descendant-most of local and last-fetched
origin. Rebase reads through to a fresher origin copy without waiting for
the local branch to advance; nothing of the parent's moves when it does.
With no origin, the local reading is all there is. Diverged readings have
no freshest side: operations that need one fail until the readings join —
ambiently when clean, by `sync` when conflicted — and staleness meanwhile
reads the local position.

When parent readings diverge, the change's history arbitrates: every base
candidate (stored set-base, merge-base against each reading) is an ancestor
of the tip, and the base is the unique maximal candidate under ancestor
order. If none dominates, the change merged unrelated lines; the user
declares a base by rebasing.

## The forge

A change's forge change is its mirror for forge-native collaborators, and
it replicates like everything else: fetch reconciles it in both directions,
absorbing forge activity into the log and mirroring log state the forge has
not seen. Observations recorded at each exchange keep either direction from
echoing the other. Because every log entry was minted by a deliberate
command, mirroring it outward mints nothing new.

The forge change comes into existence when reviewing first leaves none:
the branch at origin is already the change's replication, so the forge
change is its attention artifact, and it appears when attention is invited.
A change's archived state and its forge change's open/closed state are two
readings of the same fact, absorbed and mirrored like any other.

Branch tips ride git transport, never the forge's account of them: origin's
refs are always the freshest reading, and forges do not reliably report
rewrites. The forge exchange carries metadata — state, parent, title,
draft, reviewers, comments, approvals, merges.

Fetch reads forge activity incrementally: changes enumerate in the forge's
last-updated order, and a cursor marks how far absorption has reached, so
an idle poll costs one request and a busy one costs only the delta. The
cursor is itself shared state: absorption lands in the logs before it
advances, so it holds for anyone who has unioned them, joins by max like
any grow-only fact, and rides origin alongside the logs — whichever
machine sweeps first spares the rest the same reading. The cursor overlaps
generously on each sweep — absorption is idempotent, so re-reading is
free — and an occasional full sweep backstops the activity that forges
fail to surface in update order.

## Offline

Sync works offline: the join against origin's last-fetched readings runs,
the exchange is skipped and reported, and fetching again online converges —
everything reconciles state rather than replaying operations, so nothing
queues. Logs need nothing offline; every fetch already absorbed origin's
entries.

A log may name revisions this clone has not fetched; branch and log update
non-atomically, so no discipline prevents it. Reads render unknown
revisions as unfetched instead of failing, and log sync never waits on
branch sync.

## Forcing resolution

Reads never require unification, and behind is never an error: a trailing
local branch is either advanced by fetch (idle, or held by a clean
workspace) or read through (held by a dirty one). Writes fail fast only on
genuine ambiguity or loss: a conflicted parent asks for a join first
(`sync`, with an override to proceed on the local reading); an ambiguous
base demands a rebase; a local land whose parent does not descend from
origin's reading keeps the land local rather than push over
fetched-but-unabsorbed work.

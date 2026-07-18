# Syncing

How cabaret converges local and origin state, when it moves refs on its
own, and what remains for the user to arbitrate.

## One algebra

Everything cabaret shares is append-only, so any two copies of a thing have
a join, and convergence never needs a direction:

- Logs merge by union: any two copies combine automatically and identically
  on every machine. Divergence is a non-event.
- Branches only ever gain descendants — rebase and land are merges, never
  rewrites — so local and origin copies of a branch share their history and
  merge like any two lines of work. A conflicted join commits its markers,
  leaving the change in the fix-conflicts state; out-of-band rewrites merge
  with their own past the same way.

Push and pull are therefore not distinct operations, just transport. The
verbs are:

- `fetch` — everything unobtrusive, and what background sync runs: refresh
  origin's copies, fast-forward branches no workspace holds open, union
  every log both ways, and absorb forge activity. Never touches a working
  tree.
- `sync` — the per-change join, explicit because it may touch a working
  tree and publishes code: merge origin's copy of the branch (conflicts
  commit), push, reconcile the forge change both ways, sync the log.
- `land` — the one directional act. Sync carries no intent; landing is
  intent, and it is the single linearization point (a forge land
  compare-and-swaps on the head; a local land CASes the parent ref) that
  lets everything else be eventually consistent. A local land also pushes
  its parent: the land named the parent, so publishing its advance is
  within the intent asked.

## Local vs origin readings

A local branch is the user's working position, not evidence about a change.
Facts about a change — base, staleness, rebase target — use the freshest
reading of each branch: the descendant-most of local and last-fetched
origin. Rebase reads through to a fresher origin copy without waiting for
the local branch to advance; nothing of the parent's moves when it does.
With no origin, the local reading is all there is. Diverged readings have
no freshest side: operations that need one fail until the user joins them —
syncing the branch does — and staleness meanwhile reads the local position.

When parent readings diverge, the change's history arbitrates: every base
candidate (stored set-base, merge-base against each reading) is an ancestor
of the tip, and the base is the unique maximal candidate under ancestor
order. If none dominates, the change merged unrelated lines; the user
declares a base by rebasing.

## Eagerness and intent

Background work runs fetch on a short cadence and never touches a working
tree; views render local state immediately and refresh when a fetch lands.
The rule for what may run passively: passive operations transport
already-intended state, and never mint new publication intent. Log entries
were published when appended, so log pushes ride along with every fetch;
fast-forwarding an idle branch changes nothing anyone can observe. Branch
tips carry no publication intent until the user syncs (or lands), so those
stay explicit.

Sync works offline: the join against origin's last-fetched readings runs,
the exchange is skipped and reported, and syncing again online converges —
sync reconciles state rather than replaying operations, so nothing queues.
Logs need nothing offline; every fetch already absorbed origin's entries.

A log may name revisions this clone has not fetched; branch and log update
non-atomically, so no discipline prevents it. Reads render unknown
revisions as unfetched instead of failing, and log sync never waits on
branch sync.

## Forcing resolution

Reads never require unification, and behind is never an error: a trailing
local branch is either advanced by fetch (idle) or read through (checked
out). Writes fail fast only on genuine ambiguity or loss: a diverged parent
asks for a join first (`sync`, with an override to proceed on the local
reading); an ambiguous base demands a rebase; a local land whose parent
does not descend from origin's reading keeps the land local rather than
push over fetched-but-unabsorbed work.

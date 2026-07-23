# TODO

## Restore rename

`cab rename` (and the TUI/VS Code rename actions) were removed rather than
wired into eager replication: the old implementation moved the branch and
log refs raw, which assumed the change lived only in this repository — a
concurrent editor's appends target the old log ref, origin keeps the old
name, and the forge change's head branch does not follow. A restored rename
should be recorded in the log itself (so it replicates and merges like
every other fact), decide forge-side head-rename semantics, and reparent
children whose `set-parent` entries name the old change.

## Actions

  set-base <commit> — the natural next one. It's already listed in docs/log.md, the rebase command's docs say it "requires the
  base recorded in metadata to be valid," and reparenting without re-basing is only half the metadata story. It's also trivially
  compatible with the current line format: the payload is a single CommitHash, so it slots into the variant exactly like
  set-parent did ({ kind: "set-base"; base: CommitHash }).
  
  review <file> <base> <tip> and forget <file> — this is the core of the product (diff-based, per-file review). docs/state.md
  defines review state as a map from file to (base hash, tip hash, timestamp) with latest-timestamp-wins, so the action needs the
  file plus the two hashes; the entry's own timestamp and user supply the rest. Note log.md muses that forget might just be review
  with an empty revision — representable as revision: {base, tip} | null, which would keep the state-reduction logic in one
  place.

  add-owner <user> / remove-owner <user> and the approver equivalents — the CLI already scaffolds these, and the payload is a
  UserName (single word, line-format safe). One wrinkle: log.md requires all actions to be associative for union merging.
  Latest-timestamp-wins per (user) key makes add/remove pairs commute cleanly, but it's worth deciding that reduction rule when
  the action is added, not later.

  approve — probably pinned to a revision (approving what you saw, not the branch tip), so likely { kind: "approve"; tip:
  CommitHash }. Same associativity treatment as review.

  comment <data> last — it's in log.md but it's the one that breaks the current format. This is the flag from my previous message:
  review's file paths already strain the space-separated line (paths can contain spaces), and comments break it outright. When
  you get to review, I'd bite the bullet once and make the payload portion of the line JSON-encoded — <timestamp> <user> <kind>
  <json> — which stays one-line-per-entry (so the union merge strategy still works), handles arbitrary strings, and lets you
  derive the per-kind payload schemas from zod per the parsing preference. Doing that at review time means comment becomes free.

  Things I'd deliberately not log: rename (it moves the log ref itself, so it's an operation on the log, not in it — recording it
  inside creates a chicken-and-egg problem with the ref mirroring the branch name), and land until it's clearer whether landing is
  an event in the change's history or a terminal state derived from git itself.

  So: set-base is the cheap immediate win; review/forget is where the real design decision (payload encoding + associative
  reduction) lives, and I'd tackle it next since everything after it reuses those answers.









  TODO

- rename "approver" -> ambiguous whether this is someone who has approved or should approve
- de-vendor patdiff
- backend: commitHash -> revision, ref -> change, etc. naming in cabaret-core should be in cabaret terms.
- split commands into files
- approval
- reviewers/approvers




- cabaret create should switch to the new change maybe?
- lack of an argument should prompt an argument rather than failing


- resilience to deleted branches
- 2 column diffs (punting till later)
- land should go via forge
- add gitlab
- add jj
- look at change diff vs review
- look at multiple files' diffs at once

- caching/storage
- roles
- use cabaret language


- write simplifying assumption: single remote origin


- show page: nudges. tip (out of date) base (out of date) parent (not exist)
- add compress
- fix forge import/export
- add multi-account
- workspace management: jump to and swap
- truthiness: ban in lint
- optimization

- multi-account

- after pull: refresh
- workspace management again
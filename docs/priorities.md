# Priorities

A whole-codebase evaluation: what to improve, ranked. Ordered by tier; within a
tier, roughly by impact. Each item names the files/symbols involved so it can
be checked off or re-verified later. Items marked **[measured]** were
reproduced or benchmarked, not just read.

## 1. The distributed story exists only on paper

Log sync now exists — `syncLog`/`syncLogs` (cabaret-node `git.ts`) merge
`refs/cabaret/log/*` with origin via `mergeLogs`' canonical union, `cabaret
sync` and the `gh` commands invoke it, and reads break equal-timestamp ties on
the serialized entry — but the remaining foundations still have cracks that
are cheapest to fix before real multi-machine data exists.

- **Concurrent `createChange` merges two creations.** The exists-check in
  `createChange` (`ops.ts`) and `appendLog`'s CAS-retry loop (`git.ts`)
  compose badly: both racers see an empty log, the CAS loser retries and
  appends anyway, yielding one change with two parent/base/owner triples
  resolved by tie luck. Create needs a must-not-exist append mode. The retry
  catch also swallows non-CAS `update-ref` failures (permissions, locks).
- **`merge()`'s checked-out path is not the CAS its comment claims.**
  (`git.ts`) After `checkedOutBranch()`, `git merge --ff-only` fast-forwards
  whatever HEAD is at that moment — a user switching branches in the window
  advances the wrong branch, and it succeeds whenever HEAD is any ancestor of
  the new commit, not only when `into` still points at `onto`. `land` can
  record a merge onto a parent that moved. CAS the ref, then reset the tree.

## 2. Close the review loop

Cabaret can track review but not enforce it — the gap between a state tracker
and a review system.

- **`approve` is a stub and `land` gates on nothing.** `approve`/`approvers`
  print "not yet implemented" (cabaret-cli `app.ts`) while `cli-reference.md`
  documents them as real; `landChange` (`ops.ts`) consults no approval or
  review state. The `approve` log action design is sketched in
  [forge.md](forge.md).
- **No way to respond to what you're reading.** Comments are flat,
  change-level, and CLI-only; the VS Code diff page registers no comment
  command. `Target` already has a `location` kind (cabaret-views `doc.ts`)
  and [forge.md](forge.md) has the anchored-comment design (path + line +
  commit, mapping to forge review comments). Largest flow gap for an actual
  reviewer.
- **File arguments aren't normalized to repo-relative paths.** Existing TODOs
  on `diff` and `review` in `app.ts`: run from a subdirectory,
  `cabaret review src/x.ts` records a path the log will never match — silent
  data corruption on the primary marking command. Small fix, nasty trap.

## 3. Make the hosts agree on what a review is

- **CLI `diff` has drifted from the views layer.** `app.ts` reimplements
  `diffPage`/`rebasedView` (cabaret-views `review.ts`) — the 2-way-vs-4-way
  decision is copy-pasted verbatim — but walks `brain` + `reviewSegments`
  while views use `reviewRounds`, so the same state renders differently per
  host, against [ui.md](ui.md)'s one-view-implementation goal.
- **They also record differently.** VS Code's `markReviewed` records
  `tip: round.end`, respecting the never-read-past-an-unabsorbed-land-merge
  discipline `reviewRounds` exists for; CLI `review` records the change's
  full tip by default, silently skipping it. A correctness-of-record
  divergence, not just duplication. Port the CLI onto `diffPage`/`reviewPage`
  and round-safe marking; the CLI also gains the round list it currently
  can't show.
- **Forge-sync policy lives in the CLI host.** `syncedRequest`,
  `observedLand`, and the `gh import`/`pull`/`push` bodies sit in `app.ts`;
  [forge.md](forge.md) places them in cabaret-core next to the `Forge`
  planning functions. Until they move, the VS Code host can never grow forge
  support.

## 4. Performance

- **The todo page is a serial N+1 over git spawns.** `todoPage`
  (cabaret-views `todo.ts`) awaits `readLog` + `summarizeChange` per change
  in sequence; each summary fans out into `mergeBase`/`isAncestor`/
  `reviewSegments`/`changedFiles`/`branchTip`, each a separate spawn — call
  it 8–12 per change, so seconds at 100 changes, on the page every host
  renders most (including `refreshAll` after every VS Code action). Cheapest
  wins in order: `Promise.all` across changes; collapse log reads into
  `for-each-ref` + one `cat-file --batch` session (which also fixes
  `readFile`'s two-spawns-per-blob); only then the parent index the
  `Backend.readLog` TODO anticipates.
- **patdiff4 segment classification is quadratic with a huge constant.**
  **[measured: 108 ms → 3.6 s from 500 → 4,000 lines]** `equalForClassify`
  (patdiff `segments.ts`) runs the full diff+refine pipeline per equality
  test, `Diamond.classify` does up to six per segment, and the merge path
  re-classifies the whole accumulated slice each time a segment merges in.
  A normalized-line equality pre-check plus classifying only the newly
  merged pair collapses it. This is the one patdiff hot path the rebase
  review flow actually hits.
- **Quadratic hunk splitting in `getHunks`.** **[measured: 22× overhead]**
  (patdiff `patience-diff.ts`) rebuilds the remaining-ranges array via
  spread on every hunk break; same prepend-spread pattern in `explode.ts`
  and `float-tolerance.ts`. Mechanical fixes (push + reverse once).
- **Wide characters hang patdiff.** **[measured: OOM]** `split` in
  ansi-text `text-with-ansi.ts` makes no progress when the first character
  is wider than the remaining column, so wrapping `"中"` at width 1 loops
  until heap exhaustion. Any CJK/emoji in a narrow diff kills the process.
- **`reviewRounds` re-runs `git log` per distinct reviewed tip.**
  `remainingSpans` (cabaret-core `summary.ts`) re-invokes
  `backend.landMerges` though base..tip is fixed for the whole call —
  compute the segment list once, make reviewed-tip filtering pure.
- **`appendLog` rewrites the entire log blob per append** (`git.ts`) —
  O(log) per entry, O(n²) over a change's life, at 5–6 spawns per append.
  Harmless today; same `cat-file --batch` family as the todo-page fix.
- **The VS Code host re-does work per keystroke.** `refreshAll` re-renders
  every cached page after each action, and `markReviewed` renders the next
  diff page it opens and then `finally`-refreshes it again — two full
  renders per mark. `openBackend` re-runs `git rev-parse --show-toplevel`
  at every call site instead of caching per workspace folder, and
  `showChild`/`pickParent` re-read every change's log serially for parent
  links `todoPage` already derives.
- **ansi-text materializes a `CharInfo` object per codepoint** of every
  styled line (`text.ts`), and its `concat` re-spreads the accumulator per
  chunk — felt on every render of long lines. Same pattern class as the
  `getHunks` fix.

## 5. Structural debt

- **Structured patdiff4 output unblocks the most.** patdiff4 flattens
  rendered hunks into display strings (stripping trailing whitespace from
  real content on the way), and cabaret-views `diffDoc` regex-parses sign
  stacks back out — fragility that blocks 4-way jump targets and moving
  diff signs to the VS Code gutter (both have standing TODOs). The kernel's
  2-way path already returns `StructuredHunks`; extend patdiff4's `Block`
  with per-line provenance.
- **patdiff keeps two caller-less surfaces on purpose.** The standalone
  CLI, sexp config loading, and the terminal-emulator ANSI token modules
  are gone (the parser folds non-SGR escapes into `UnknownEsc` and
  round-trips them byte-for-byte). Kept despite having no Cabaret caller:
  `side-by-side.ts` and its config knobs (candidate renderer for a future
  TUI), and patience-diff's OCaml-parity `merge` /
  `limitInfiniteContextHunkToContext`. Don't re-flag these as dead code;
  revisit if the TUI question resolves against them.
- **app.ts is a monolith with hand-repeated flag types.** Every stricli
  `func` re-declares its flag type by hand, so the parse table and type can
  drift silently; splitting routes per file (comments, gh, review, …) makes
  each pairing locally checkable.
- **The patdiff kernel isn't as pure as the README claims.** `PatdiffCore`
  writes to `process.stdout` in two places despite the kernel being
  advertised as browser-safe; the "no Node deps" boundary should be
  enforced, not asserted. Other port artifacts in the same sweep:
  `Attr.toCode` is a zero-caller hand-maintained duplicate of the 35-case
  SGR table in `toString`; `ExplodedToken` and `WordOrNewline` differ only
  in tag capitalization with a conversion shim between them; `getRangesRev`
  returns forward order despite its name and is double-reversed downstream;
  `defaultDoubleColumnWidth` is defined twice.

## 6. Robustness and hygiene

- **Routine states crash with stack traces.** A deleted parent branch (the
  normal state after a parent lands) kills `cabaret todo`: `changeBase` →
  `mergeBase` exits 128 with a non-`UserError` for every descendant, and
  `nextStep` compounds it by advising a rebase that will itself fail. Rebase
  conflicts likewise surface as raw wrapped git errors (standing TODO in
  `git.ts`). Both deserve `UserError`s naming the way out.
- **`fetchBranch` is fast-forward-only in a rebase-freely system.** After
  any teammate rebase, `gh pull`'s fetch fails forever with a raw git error
  and no recovery path. Safe fix: reset local to remote when local has no
  unpushed work, or at least a `UserError` saying what to do.
- **No CI.** The suite is green and ~10 s; a workflow running
  `build`/`test`/`check` on PRs is an hour of work.
- **Wrong-PR selection on multi-base heads.** `findRequest` uses
  `gh pr list --head X --limit 1` (cabaret-node `github.ts`); GitHub allows
  several open PRs per head, so comment sync can target the wrong one.
  `createRequest` discards `gh pr create`'s URL and re-finds by head,
  inheriting the ambiguity plus a race — parse the URL instead.
- **planPull trusts any marker.** A forge comment whose body carries a
  `<!-- cabaret:<hash> -->` matching a local entry is treated as our
  reflection or a supersession — a quoted/pasted marker can silently hide
  someone else's comment. Check the claimed author at minimum.
- **`patdiff()` applies float tolerance after refine; `compareLines` before.**
  **[measured]** With tolerance set, `compareLines` returns no hunks but
  default-Ansi `patdiff()` still renders the diff (tolerance ends up
  comparing ANSI-styled strings). Match `compare-core.ts`'s ordering.
- **Binary detection runs after UTF-8 decoding** in patdiff
  `lib/compare-core.ts`: invalid bytes become U+FFFD first, so two
  byte-different binaries can compare "Same". Detect on a Buffer.
- Smaller, same spirit:
  - `userName` (cabaret-core `backend.ts`) is the one brand that doesn't
    validate; empty names only explode later in the schema re-parse.
  - `reparent` validates nothing (standing TODO in `ops.ts`): reparenting
    onto a typo or your own descendant is accepted and only caught when
    `changeForest` throws while rendering todo.
  - Comment hashes flow as bare `string` through the same maps as forge
    comment ids (`forge.ts`); a `CommentHash` brand would separate them.
  - `(error as { code?: unknown }).code === 1` is hand-rolled six times in
    `git.ts`; extract one helper before a call site forgets the
    anything-else-is-real-failure discipline.
  - Unchecked-index casts in cabaret-views `table.ts` (`row[i] as Span`).
  - The VS Code extension's interactive logic (next-file wrap,
    `selectedChanges`, rename-follow) has no tests, in contrast to the
    strong CLI e2e suite; it's exactly extractable-pure logic.
  - Docs drift: [cli.md](cli.md) documents `create --child` and
    `rebase --allow-invalid-base`, which don't exist; `glab pull/push`
    stubs appear in `cli-reference.md` unmarked.
  - patdiff fail-fast gaps: `blocks[i] ?? []` in `diff-algo.ts` renders a
    header with no body on misalignment; the side-by-side move back-patch
    silently no-ops on bookkeeping mismatch; `matchRatio([], [])` is `NaN`.
  - ansi-text parses colon-form SGR (`38:2:r:g:b`, the form modern tools
    emit) as a spurious Reset — the empty param list after dropping colon
    args defaults to `[0]`. Related: `\x1b[;31m` loses its implied reset,
    and CSI intermediate bytes are dropped so `\x1b[0 m` misparses as Reset.

## 7. Noted, not prioritized

Findings recorded so they aren't re-discovered; none is urgent alone, but
several become relevant the moment nearby code is touched.

### patdiff correctness tail

- **Unbounded recursion in patience `matches`.** The OCaml tail calls were
  TCO'd; the JS port grows the stack (`patience-diff.ts` `recurse`,
  four self-call sites). `plain-diff.ts` already got the explicit-stack
  conversion this function did not; adversarially nested input can
  overflow with no recovery.
- **Side-by-side width handling is inconsistent.** The body clamps pane
  width to `MIN_COL_WIDTH` but the header computes its divider unclamped,
  so at `widthOverride: 80` the dividers misalign and overrides below
  ~121 are silently ignored for the body; `withoutUnix` also reports
  width 120 where the OCaml default appears to be 121 — check upstream.
- **Lenient parsing where the port should reject.** `Percent.parse("x")`
  succeeds as 0 because `Number("")` is 0, so a typo'd threshold silently
  becomes 0; the sexp lexer accepts `\999` escapes sexplib rejects and its
  block-comment scanner ignores quoted strings, so `#| "|#" |#` terminates
  early.
- **A guard in `refine.ts` is asymmetric** (`prev < 200 && next < 100`)
  where OCaml's check looks symmetric — possibly a transcription typo that
  shifts refinement boundaries for 100–199-line replace blocks; verify
  against upstream before "fixing" either way.
- **`infiniteContext = 100_000` is a cliff, not infinity.** patdiff4's
  inner ddiffs use it as "infinite" context; files past 100k lines
  silently misalign the outer ddiff. `getHunks` already treats `-1` as
  infinite — use that.
- **`extractTodos` linear-scans `lineStarts` per TODO** (cabaret-core
  `todo.ts`) — O(todos × lines); binary search if big generated files
  ever matter.

### Test-suite honesty

- `stub as Backend` casts in `ops.test.ts`, `summary.test.ts`, and
  `backend.test.ts` are unsound — a typed partial-backend helper would
  keep the compiler honest as `Backend` grows.
- Core ops (`createChange`, `rebaseChain` ordering, `landChain`'s
  landed-parent guard) are tested only through CLI e2e; `ops.test.ts`
  covers just `resolveChain`. Fine while e2e is strong, but refactors of
  ops get no fast signal.
- `limitInfiniteContextHunkToContext`'s fast-check test will flake the day
  the generator produces equal arrays, and the function demonstrably
  diverges from `getHunks` on identical inputs — the function is kept
  deliberately (§5), so fix the divergence or constrain the generator.
- patdiff's `smoke.test.ts` asserts `1+1 === 2` — against the
  no-tautological-tests rule.

### Forge sync: designed but not built

[forge.md](forge.md)'s follow-ups, listed here so the doc is one-stop:
no anchored/inline comments (§2 covers the Cabaret half), no `approve`
action or approval sync, no `GitLabForge` to prove the interface
generalizes, no PR descriptions — `createRequest` posts `--body ""`,
which also forfeits the trailer-in-description squash mitigation the doc
proposes — and no rename retargeting or teammate-side merge handling.

### Docs vs. reality

[architecture.md](architecture.md) presents `cabaret-web` as a peer
frontend; it doesn't exist. Fine as intent, but the doc reads as
current-state.

## Where to start

Three picks, if picking three:

1. **The `createChange` and `merge()` races** (§1) — the last convergence
   cracks now that logs sync, and they get harder once real multi-machine
   data exists.
2. **Approval gating on `land`** (§2) — closes the review loop; the log
   action design already exists in [forge.md](forge.md).
3. **Port CLI `diff`/`review` onto the views layer** (§3) — kills the
   host divergence before the two record formats drift further apart.

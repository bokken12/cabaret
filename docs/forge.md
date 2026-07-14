# Forge Sync

How `cabaret pull` and `cabaret push` let one Cabaret user collaborate with teammates who only use GitHub. The bar is Graphite's: the basics must sync faithfully in both directions, and a few visible oddities on the GitHub side are acceptable.

## Naming

"Frontend" would be the natural dual to `Backend`, but `architecture.md` already uses "frontend" for the UI layer (`cabaret-cli`, `cabaret-vscode`). GitHub, GitLab, Gitea, and friends are conventionally called forges, and the term has no collision here.

Tentative: the interface is `Forge`, implemented by `GitHubForge` and `GitLabForge`. If this turns out badly, my second choice is `Host`.

## Shape of the feature

- `Forge` interface and all sync logic live in `cabaret-core` (`forge.ts`), mirroring `Backend`: a small imperative interface plus pure free functions that do the actual thinking.
- Concrete implementations live in `cabaret-github` (and eventually `cabaret-gitlab`), platform-agnostic so browsers can run them; `cabaret-node` contributes only what needs a local machine — finding the repository and a token.
- `LocalContext` grows a `forge()` next to `backend()`, and the existing `cabaret pull` / `cabaret push` stubs in `app.ts` call into the sync functions.

The sync logic should be pure planning over data: `planPull(log, forgeState) → entries to append` and `planPush(log, forgeState) → comments to post`. The commands fetch state, plan, apply. This keeps the interesting logic (idempotency, dedup, supersession) testable without any fake HTTP — and idempotency itself becomes a property test: planning again after applying must yield the empty plan.

## Transport and auth

`GitHubForge` speaks the REST API directly through octokit (`@octokit/core` with GitHub's own throttling and retry plugins, so rate limits are handled the way GitHub documents). Octokit runs on `fetch`, so the same forge runs wherever `fetch` exists, including a browser.

Auth is a bearer token the host supplies. On Node, `openGitHubForge` takes it from `$GH_TOKEN`/`$GITHUB_TOKEN` or `gh auth token`, so auth stays delegated to `gh auth login` and Cabaret stores nothing; a browser host is handed a token by its user. Which repo to talk to is likewise host-supplied: on Node it is derived from `remote.origin.url` — consistent with `currentUser()` reading `git config user.email` — while a browser host names the repository directly.

## Associating a change with a pull request

A change maps to a PR: the change's branch is the head, its parent's branch is the base (so stacks become stacked PRs with non-default bases, which GitHub supports).

The association could be derived purely from the head branch name, but branches get renamed, PRs get closed and reopened, and a branch can have had several PRs over its life. Instead the association is recorded in the log, where it merges and syncs like everything else:

- `set-forge` with a `forge` locator (e.g. `github.com/org/repo`) and the forge change's `id` number, latest wins.

`cabaret push` creates the PR if the log doesn't name one (title from the change name, base from the parent) and records `set-forge`. `cabaret pull` can adopt an existing PR found by head branch and record the same.

## Comment sync

GitHub has three comment species: issue comments (flat, PR-level), review comments (inline, threaded, anchored to path/line/commit), and review bodies (with an approval verdict). Cabaret today has exactly one: flat, change-level, immutable `comment` log entries.

So the first cut syncs Cabaret comments ↔ PR issue comments, which match structurally. Inline comments require Cabaret to grow anchored comments first, and approvals require an `approve` log action; both are follow-ups (see the end), and the design below extends to them without rework.

### Identity

Idempotency needs each comment to have a stable identity on both sides. The cautionary tale here is google/git-pull-request-mirror (the git-appraise ↔ GitHub bridge), which instead matches comments by fuzzy author+body comparison: any edit to a body makes the comment "new" again and it mirrors twice, and its planned loop-avoidance was recognizing its own comments by quoting heuristics. Stable ids sidestep that whole failure class.

- A GitHub comment's identity is its comment id — stable across edits.
- A Cabaret comment's identity is the hash of its serialized log entry (git-appraise does exactly this). Entries are immutable, so the hash is permanent.

The two directions store the cross-reference in opposite places:

**Pull** stamps provenance into the imported entry itself: every log entry has an optional top-level `source` field — beside `timestamp` and `user`, since provenance is metadata about how the entry got written, not part of the action's meaning — carrying the forge locator and, for objects the forge keeps (comments), the forge-side id. An entry with `source` mirrors the forge; one without originated locally. Every entry a pull imports or a push observes carries it, whatever its action.

**Push** stamps provenance into the GitHub comment body: an invisible HTML comment `<!-- cabaret:<entry-hash> -->` (markdown swallows it in rendering). GitHub itself is then the record of what has been pushed — no local "already posted" state that a second machine would lack.

No separate id-mapping table exists anywhere; the mapping is reconstructible from the log plus the PR's comments, both of which every machine can see.

### Pull

For each issue comment on the PR, import a log entry:

- `timestamp`: the forge's own clock — `updated_at` (which equals `created_at` when never edited), in ms.
- `user`: the author's public profile email when their account shows one, else `login@users.noreply.github.com` (GitHub's real noreply convention; `identity.md` already accepts that identity is unverified).
- `source`: the forge locator and the comment's id.
- `action`: `comment` with the body as `text`.

Skip any comment whose id already appears as a `source` in the log, and any comment bearing a `cabaret:` marker whose hash matches a local entry (that's our own reflection — importing it would echo).

Because every field above is determined by the forge's data and nothing local (no local clock, no local user), two machines pulling the same comment produce byte-identical lines — so when log refs themselves sync, union merging dedups them for free. This is the same associativity argument the rest of the log leans on, extended across machines.

### Push

Push every local-origin comment entry (no `source`) whose hash doesn't already appear in a marker on the PR. Listing before posting is the cross-machine dedup; there is a small race if two machines push the same entry simultaneously, which we accept (rare, harmless, manually deletable) rather than build coordination for.

Comments are posted by whoever's token it is, so when the entry's `user` isn't the pusher, prefix the body with an attribution line (`**bob@example.com:**`). This is the most Graphite-flavored oddity in the design and seems fine.

### Edits

GitHub comments mutate in place; the log never mutates. The bridge is supersession, which is Cabaret's native idiom anyway: when pull sees a comment whose body no longer matches the newest entry with that `source` id, it imports a fresh entry (new `updated_at` timestamp, same `source`). Display-time derivation groups entries by `source` id and shows the latest — precisely the latest-timestamp-wins fold used for `set-parent`, brains, and everything else.

An edit to a comment that *originated* in Cabaret works the same way: the marker links the GitHub id back to the original entry's hash, and the imported superseding entry records that hash in its action's `edits` field so derivation can group them (markers are stripped from imported bodies). Supersession is a property of comments, not of forge provenance — a future local comment edit writes the same `edits` link with no `source` at all.

Cabaret-side comments are immutable, so push never needs to PATCH anything. If Cabaret ever grows comment editing, it should adopt the same supersession shape, and push maps it to a PATCH.

Deletions on GitHub are ignored for now: the entry simply survives in the log. A tombstone action is possible if this grates.

## Change ↔ PR lifecycle

This is the less certain half. What syncs comfortably:

- **Creation**: `cabaret push` pushes the branch (`--force-with-lease`, since changes rebase) and opens the PR.
- **Reparent**: `cabaret push` updates the PR base to match the current parent.
- **Rename**: pushes the new branch and retargets the PR head... which GitHub does not support; in practice this closes and reopens. An oddity to paper over later.
- **Close/merge state**: `cabaret pull` records a merged PR as landing the change. `cabaret push` sees the same state but only sends — the directions stay separate.

Landing is where the models genuinely diverge. `cabaret land` produces a merge commit carrying the `Cabaret-Landed` trailer, which is what lets parent reviewers skip already-reviewed diffs. A teammate pressing GitHub's merge button produces a merge (or worse, a squash) without the trailer, so that machinery misses it. `cabaret pull` can at least append the `land` entry when it sees the PR merged, recording the merge commit and freezing the change correctly — but the trailer-based review skip is lost, and a squash merge diverges history outright.

Tentative: pull records forge-side merges as `land`, and the recommended workflow is that the Cabaret user does the landing (`cabaret land` then `cabaret push`, which closes the PR as merged). Making teammate-side merges first-class can come later if it earns its keep.

A partial mitigation worth pursuing: have `cabaret push` end the PR description with the `Cabaret-Landed` trailer. When the repo's squash-message setting is "pull request title and description" (or the merger keeps the prefilled message), the trailer rides into the squash commit — trailers must sit in the message's final paragraph, so it must stay the last line. `landMerges` would then need to accept trailer-bearing ordinary commits, not just merges, treating the squash's diff as the reviewed diff. Best-effort only, since it leans on repo settings and the merger not editing the message.

## Pull imports everything

There is one representation of a forge change: its change log. `cabaret pull` imports every open forge change that has no log yet as a change to review — owned by its author, parented on its target branch, its discussion pulled — then refreshes every tracked change and syncs logs with origin. There is no separate import command, no local mirror of forge state, and no "unimported" rendering: the todo and show pages read change logs alone, so rendering never calls the forge and works offline between pulls.

The bulk sweep is one GraphQL query per hundred open changes, each carrying its comments capped at the first hundred; when the cap bites (`commentsTruncated`), the importer falls back to `listComments` for the full discussion.

Two machines pulling concurrently import the same change twice, each stamping its `set-*` entries with its own clock and identity. That is fine by construction: union merging keeps both machines' entries and every read takes the latest, so the most recent observation of the forge wins. (Comment imports are stronger — determined by forge data alone, they dedupe byte-identically, per Pull above.)

A change whose forge change closes unmerged is pruned on the next pull when its log is a pure import — every entry carries a forge `source` — since nobody engaged with it and the forge walked away. An engaged change stays, closed forge change or not, exactly like a native change whose branch dies. (Follow-up: a `close` log action, so an engaged change whose forge change closes stops lingering in todo.)

Retargets mirror in both directions. `cabaret push` retargets the forge change to the local parent; `cabaret pull` reparents the change when the forge's target branch moved. Telling a forge-side retarget apart from a not-yet-pushed local reparent needs one more bit: a `set-parent` entry carries the forge `source` whenever the forge's parent is *observed* — at import, at adoption when the sides already agree, and by every push that sets it. Pull then compares the forge's parent against the last observed one, not against local intent: a forge that moved since last observed mirrors in and wins by timestamp, while a local reparent awaiting its push is left alone.

## Reviewers

A change's reviewers sync with the forge's — GitHub's requested reviewers, GitLab's MR reviewers. `ForgeChange` carries `reviewers` (mapped to Cabaret identities), and `Forge.setReviewers` maps identities back to forge accounts: noreply-convention identities invert directly, anything else is looked up by public email, and an identity with no account fails the push.

The sync generalizes the retarget bit to a set, per user. Pull mirrors in every user whose forge membership differs from the last observed one, as a source-stamped `add-reviewer`/`remove-reviewer`. Push first absorbs that same mirror, so what remains between the log and the forge is exactly local intent: it requests the log's reviewers the forge lacks, withdraws the forge's the log dropped, and stamps observations so the next pull mirrors nothing back.

One forge oddity to know about: GitHub drops a reviewer from `requested_reviewers` the moment they submit a review, so its reviewer set is read as requested ∪ reviewed — and a reviewer who has already reviewed cannot be withdrawn there, so a local removal mirrors back in on the next pull.

## The `Forge` interface

Small, imperative, everything the planner can't compute:

```ts
interface Forge {
  /** The open forge change with head `branch`, if any. */
  findChange(branch: RefName): Promise<ForgeChange | undefined>;
  /** Every open forge change with its comments, in one bulk sweep. */
  fetchOpenChanges(): Promise<readonly OpenChange[]>;
  getChange(id: ForgeChangeId): Promise<ForgeChange>;
  createChange(head: RefName, parent: RefName, title: string): Promise<ForgeChange>;
  setParent(id: ForgeChangeId, parent: RefName): Promise<void>;
  listComments(id: ForgeChangeId): Promise<readonly ForgeComment[]>;
  addComment(id: ForgeChangeId, body: string): Promise<void>;
  setReviewers(id: ForgeChangeId, add: readonly UserName[], remove: readonly UserName[]): Promise<void>;
}
```

with `ForgeComment` carrying `id`, `author`, `body`, `updatedAt`; `ForgeChange` carrying `id`, `head`, `parent`, `title`, `author`, `state`, `reviewers`, `merge`; and `OpenChange` pairing a `ForgeChange` with its (possibly capped) comments. Branded ids, zod at the API boundary, per house style. GitLab's MR surface maps onto every method here, which is the point of the interface.

The web app is a pure viewer: its backend reads logs straight from origin, and a browser has no local tier for a pull to import into, so importing is `cabaret pull`'s job from a checkout. Open forge changes nobody has pulled are simply not visible there yet.

## Data model changes

- Log entries: optional top-level `source: { forge, id? }` beside `timestamp` and `user`.
- `comment` action: optional `edits` naming the entry a version supersedes.
- `set-forge` action: `{ forge, id }`, latest wins.
- `add-reviewer`/`remove-reviewer` actions: per user, latest wins.
- Pure derivations: current forge change; current and forge-observed reviewers; comments grouped by identity with latest-version-wins.

No migrations (pre-1.0).

## Follow-ups

- **Inline comments**: give Cabaret anchored comments (path + line + commit, à la git-appraise's `Location`) and map them to GitHub review comments (`path`/`line`/`in_reply_to`). The identity/marker scheme above carries over unchanged. (When anchoring, derive file lines by parsing diff hunk headers rather than trusting GitHub's `position` field — git-pull-request-mirror's one broadly reusable piece.)
- **Approvals**: an `approve` log action (the CLI stub already exists) mapping to GitHub approving reviews, both directions.
- **GitLab**: `GitLabForge` over `glab`, proving the interface generalizes before it ossifies.
- **Descriptions**: changes have no description today; PRs want a body. Worth adding to Cabaret regardless.
- **Rename retargeting** and **teammate-side merges** (including the trailer-in-description mitigation), per above.

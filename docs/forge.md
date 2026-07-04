# Forge Sync

How `cabaret gh` (and later `cabaret glab`) lets one Cabaret user collaborate with teammates who only use GitHub. The bar is Graphite's: the basics must sync faithfully in both directions, and a few visible oddities on the GitHub side are acceptable.

## Naming

"Frontend" would be the natural dual to `Backend`, but `architecture.md` already uses "frontend" for the UI layer (`cabaret-cli`, `cabaret-web`, `cabaret-vscode`). GitHub, GitLab, Gitea, and friends are conventionally called forges, and the term has no collision here.

Tentative: the interface is `Forge`, implemented by `GitHubForge` and `GitLabForge`. If this turns out badly, my second choice is `Host`.

## Shape of the feature

- `Forge` interface and all sync logic live in `cabaret-core` (`forge.ts`), mirroring `Backend`: a small imperative interface plus pure free functions that do the actual thinking.
- Concrete implementations live in `cabaret-node`, next to `GitBackend`.
- `LocalContext` grows a `forge()` next to `backend()`, and the existing `gh pull` / `gh push` stubs in `app.ts` call into the sync functions.

The sync logic should be pure planning over data: `planPull(log, requestState) → entries to append` and `planPush(log, requestState) → comments to post`. The commands fetch state, plan, apply. This keeps the interesting logic (idempotency, dedup, supersession) testable without any fake HTTP — and idempotency itself becomes a property test: planning again after applying must yield the empty plan.

## Transport and auth

Rather than taking on octokit, an HTTP client, and token management, shell out to the `gh` CLI (`gh api` reaches the full REST/GraphQL surface), exactly as `GitBackend` shells out to `git`. Auth is delegated wholesale to `gh auth login`; Cabaret never sees a token, and there is nothing to configure. `glab` offers the same for GitLab, so the symmetry holds.

Which repo to talk to is derived from `remote.origin.url` — consistent with `currentUser()` reading `git config user.email`.

Tentative: shell out to `gh`. Requiring `gh` to be installed is an acceptable oddity; the `Forge` interface keeps a direct-HTTP implementation possible if it isn't.

## Associating a change with a pull request

A change maps to a PR: the change's branch is the head, its parent's branch is the base (so stacks become stacked PRs with non-default bases, which GitHub supports).

The association could be derived purely from the head branch name, but branches get renamed, PRs get closed and reopened, and a branch can have had several PRs over its life. Instead the association is recorded in the log, where it merges and syncs like everything else:

- `set-forge` with a `forge` locator (e.g. `github.com/org/repo`) and a `request` number, latest wins.

`gh push` creates the PR if the log doesn't name one (title from the change name, base from the parent) and records `set-forge`. `gh pull` can adopt an existing PR found by head branch and record the same.

## Comment sync

GitHub has three comment species: issue comments (flat, PR-level), review comments (inline, threaded, anchored to path/line/commit), and review bodies (with an approval verdict). Cabaret today has exactly one: flat, change-level, immutable `comment` log entries.

So the first cut syncs Cabaret comments ↔ PR issue comments, which match structurally. Inline comments require Cabaret to grow anchored comments first, and approvals require an `approve` log action; both are follow-ups (see the end), and the design below extends to them without rework.

### Identity

Idempotency needs each comment to have a stable identity on both sides. The cautionary tale here is google/git-pull-request-mirror (the git-appraise ↔ GitHub bridge), which instead matches comments by fuzzy author+body comparison: any edit to a body makes the comment "new" again and it mirrors twice, and its planned loop-avoidance was recognizing its own comments by quoting heuristics. Stable ids sidestep that whole failure class.

- A GitHub comment's identity is its comment id — stable across edits.
- A Cabaret comment's identity is the hash of its serialized log entry (git-appraise does exactly this). Entries are immutable, so the hash is permanent.

The two directions store the cross-reference in opposite places:

**Pull** stamps provenance into the imported entry itself: the `comment` action gains an optional `source` field carrying the forge locator and comment id. An entry with `source` came from the forge; one without originated locally.

**Push** stamps provenance into the GitHub comment body: an invisible HTML comment `<!-- cabaret:<entry-hash> -->` (markdown swallows it in rendering). GitHub itself is then the record of what has been pushed — no local "already posted" state that a second machine would lack.

No separate id-mapping table exists anywhere; the mapping is reconstructible from the log plus the PR's comments, both of which every machine can see.

### Pull

For each issue comment on the PR, import a log entry:

- `timestamp`: the forge's own clock — `updated_at` (which equals `created_at` when never edited), in ms.
- `user`: the author's `login@users.noreply.github.com` (GitHub's real noreply convention; actual emails aren't exposed by the API, and `identity.md` already accepts that identity is unverified).
- `action`: `comment` with the body as `text` and `source` set.

Skip any comment whose id already appears as a `source` in the log, and any comment bearing a `cabaret:` marker whose hash matches a local entry (that's our own reflection — importing it would echo).

Because every field above is determined by the forge's data and nothing local (no local clock, no local user), two machines pulling the same comment produce byte-identical lines — so when log refs themselves sync, union merging dedups them for free. This is the same associativity argument the rest of the log leans on, extended across machines.

### Push

Push every local-origin comment entry (no `source`) whose hash doesn't already appear in a marker on the PR. Listing before posting is the cross-machine dedup; there is a small race if two machines push the same entry simultaneously, which we accept (rare, harmless, manually deletable) rather than build coordination for.

Comments are posted by whoever's token it is, so when the entry's `user` isn't the pusher, prefix the body with an attribution line (`**bob@example.com:**`). This is the most Graphite-flavored oddity in the design and seems fine.

### Edits

GitHub comments mutate in place; the log never mutates. The bridge is supersession, which is Cabaret's native idiom anyway: when pull sees a comment whose body no longer matches the newest entry with that `source` id, it imports a fresh entry (new `updated_at` timestamp, same `source`). Display-time derivation groups entries by `source` id and shows the latest — precisely the latest-timestamp-wins fold used for `set-parent`, brains, and everything else.

An edit to a comment that *originated* in Cabaret works the same way: the marker links the GitHub id back to the original entry's hash, and the imported superseding entry records that hash in its `source` so derivation can group them (markers are stripped from imported bodies).

Cabaret-side comments are immutable, so push never needs to PATCH anything. If Cabaret ever grows comment editing, it should adopt the same supersession shape, and push maps it to a PATCH.

Deletions on GitHub are ignored for now: the entry simply survives in the log. A tombstone action is possible if this grates.

## Change ↔ PR lifecycle

This is the less certain half. What syncs comfortably:

- **Creation**: `gh push` pushes the branch (`--force-with-lease`, since changes rebase) and opens the PR.
- **Reparent**: `gh push` updates the PR base to match the current parent.
- **Rename**: pushes the new branch and retargets the PR head... which GitHub does not support; in practice this closes and reopens. An oddity to paper over later.
- **Close/merge state**: `gh pull` observes it.

Landing is where the models genuinely diverge. `cabaret land` produces a merge commit carrying the `Cabaret-Landed` trailer, which is what lets parent reviewers skip already-reviewed diffs. A teammate pressing GitHub's merge button produces a merge (or worse, a squash) without the trailer, so that machinery misses it. `gh pull` can at least append the `land` entry when it sees the PR merged, recording the merge commit and freezing the change correctly — but the trailer-based review skip is lost, and a squash merge diverges history outright.

Tentative: pull records forge-side merges as `land`, and the recommended workflow is that the Cabaret user does the landing (`cabaret land` then `gh push`, which closes the PR as merged). Making teammate-side merges first-class can come later if it earns its keep.

A partial mitigation worth pursuing: have `gh push` end the PR description with the `Cabaret-Landed` trailer. When the repo's squash-message setting is "pull request title and description" (or the merger keeps the prefilled message), the trailer rides into the squash commit — trailers must sit in the message's final paragraph, so it must stay the last line. `landMerges` would then need to accept trailer-bearing ordinary commits, not just merges, treating the squash's diff as the reviewed diff. Best-effort only, since it leans on repo settings and the merger not editing the message.

## The `Forge` interface

Small, imperative, everything the planner can't compute:

```ts
interface Forge {
  /** The open request with head `branch`, if any. */
  findRequest(branch: RefName): Promise<ForgeRequest | undefined>;
  getRequest(id: ForgeRequestId): Promise<ForgeRequest>;
  createRequest(head: RefName, base: RefName, title: string): Promise<ForgeRequest>;
  setBase(id: ForgeRequestId, base: RefName): Promise<void>;
  listComments(id: ForgeRequestId): Promise<readonly ForgeComment[]>;
  addComment(id: ForgeRequestId, body: string): Promise<void>;
}
```

with `ForgeComment` carrying `id`, `author`, `body`, `updatedAt`, and `ForgeRequest` carrying `id`, `head`, `base`, `title`, `author`, `state`, `merge`. Branded ids, zod at the API boundary, per house style. GitLab's MR surface maps onto every method here, which is the point of the interface.

## Data model changes

- `comment` action: optional `source: { forge, id }`.
- New `set-forge` action: `{ forge, request }`, latest wins.
- New pure derivations: current forge request; comments grouped by identity with latest-version-wins.

All additive to `LogActionSchema`; no migrations (pre-1.0).

## Follow-ups

- **Inline comments**: give Cabaret anchored comments (path + line + commit, à la git-appraise's `Location`) and map them to GitHub review comments (`path`/`line`/`in_reply_to`). The identity/marker scheme above carries over unchanged. (When anchoring, derive file lines by parsing diff hunk headers rather than trusting GitHub's `position` field — git-pull-request-mirror's one broadly reusable piece.)
- **Approvals**: an `approve` log action (the CLI stub already exists) mapping to GitHub approving reviews, both directions.
- **GitLab**: `GitLabForge` over `glab`, proving the interface generalizes before it ossifies.
- **Descriptions**: changes have no description today; PRs want a body. Worth adding to Cabaret regardless.
- **Rename retargeting** and **teammate-side merges** (including the trailer-in-description mitigation), per above.

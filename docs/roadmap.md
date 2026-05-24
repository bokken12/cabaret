# Roadmap

The approach: build the smallest possible end-to-end loop first — a CLI doing diff-based review against a real PR — and only layer on additional surfaces (VSCode plugin, web app) and features (comments, obligations) once the core model has been validated against real use.

## Principle

**Validate the brain model against real work before committing to abstractions.** The right design will reveal itself after the first working pass. Resist building the package layout, the Backend interface, and a GitHub REST transport before there is any working code that exercises them. Each milestone below should be dogfooded against real PRs you actually care about before moving on.

## Milestones

### 0 — Scaffold

- pnpm monorepo: `packages/core`, `packages/backend`, `packages/cli`
- TS strict mode, eslint, vitest
- Core types: `BlobSha`, `MarkKind`, `BrainEntry`, `Diff2`, `Diff4` — discriminated unions and branded primitives from the start
- `Backend` interface (signatures only, no implementations yet)

### 1 — Read-only `cabaret status`

- Implement the local-git transport in `backend` — shell out to `git` for `ls-tree`, `diff-tree`, `cat-file`, `fetch`
- Read PR metadata via the `gh` CLI for now (avoid `octokit` until forge integration becomes nontrivial)
- `cabaret status <PR>` classifies each changed file as `reviewed` / `stale` / `unreviewed`
- **Brain stored as a local JSON file in `~/.cabaret/` for this phase.** Skip git refs until the model is validated.

This is the smallest useful artifact. It validates the brain semantics, the diff computation, and the model against a real PR — without any storage complexity in the critical path.

### 2 — `cabaret accept` and `accept-file`

- Brain writes (still to the local JSON file)
- The full review loop now works end-to-end on one device

### 3 — Move brain to git refs

- Read/write `refs/cabaret/users/<user>/prs/<n>`
- Multi-device sync via vanilla `git push`/`git fetch`
- Migration: copy existing JSON brain into refs on first run

### 4 — `cabaret diff` (diff4 rendering)

- The diff-of-diffs is the most novel display logic in the project. Dogfood and iterate until it's actually pleasant to read.
- Iron's `patdiff4` is worth studying here, but the implementation should be a parser over `git diff` output rather than a custom diff engine.

### 5 — Rev-updates

- Detect when a file's `(old_base, old_tip) → (new_base, new_tip)` results in no actual content change
- Silently advance the brain with `mark_kind = Internal`
- This is the "rebase doesn't bother me" payoff — the moment cabaret most visibly justifies its existence over GitHub

### 6 — Polish

- Rename detection (`git diff -M` heuristics)
- File deletion / forgetting
- PR metadata caching under `refs/cabaret/prs/<n>/*`
- Multi-device conflict handling (rare with per-PR refs, but verify the merge path works)

### 7 — Second-user dogfooding

- Open the workflow to one collaborator
- Find the gaps that solo use missed (likely around comment ergonomics and discoverability)

### 8 — VSCode plugin

- Only once the CLI is genuinely pleasant to use solo and with one collaborator
- Wire into VSCode's diff viewer; sidebar for PR list and per-file status
- Reuses `core` and `backend` from the CLI — no new abstractions needed

### Later (uncommitted)

- **In-code comments.** Inline in source files, eventually mirrorable to GitHub PR comments.
- **Review obligations.** Better-CODEOWNERS, living in `.cabaret/`.
- **GitHub REST transport.** Lets a future web client read and write refs without a local clone.
- **Web app.** Browser-side review experience for when a local clone isn't available.

## What to defer aggressively

- **The VSCode plugin and web app are tempting but should wait.** Premature surface multiplication forces premature abstraction; the second consumer always shapes the contract better than imagination does.
- **The `ForgeIntegration` abstraction shouldn't exist until there's a real second forge.** For now, everything is GitHub-specific and that's fine.
- **No custom diff algorithm.** Use `git diff` and parse its output — even diff4 can be expressed as operations over textual diffs.
- **No multi-language complexity.** Pure TypeScript across packages until performance or correctness pressure forces something native.

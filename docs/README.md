# Cabaret

A personal/local-first code review tool inspired by Jane Street's [Iron](https://github.com/janestreet/iron), built to replace the GitHub PR review experience without requiring a server or team adoption.

## Why

GitHub's review UI handles diff-based review badly. When a PR is rebased or force-pushed, your "what I've already reviewed" state evaporates: you end up re-reading code you already approved, or trying to follow per-commit diffs that don't reflect what actually changed for you. Cabaret fixes this with a content-addressed *brain* — a per-reviewer record of what blob you last saw for each file — so rebases and force-pushes are invisible.

## Goals

- **Diff-based review.** Show only what's new since my last look, surviving rebases and force-pushes.
- **Local-first / jj-philosophy.** Useful to a solo reviewer with zero team adoption. No server. CLI only.
- **Multi-device.** Review state syncs via the git repo — laptop and desktop pick up where each other left off.
- **GitHub-backend.** Works on top of vanilla GitHub PRs. Teammates don't need to install anything.

## Non-goals (for now)

- **In-code comments.** Eventually they'll live inline in source files, not in a separate UI — but not yet.
- **Review obligations** (a more evolved CODEOWNERS).
- **Web UI or collaborative server.**

## Design

### The brain

For each `(reviewer, PR, file)` cabaret records a triple:

```
(base_blob_sha, tip_blob_sha, mark_kind)
```

— the pair of blob SHAs the reviewer last saw for that file (one for the PR's base, one for the tip), plus a tag indicating whether the brain was advanced by an explicit acceptance (`User`) or an implicit one (`Internal`, e.g. a rebase that didn't actually change the file's contribution).

The shape is borrowed from Iron's `Marked_diff2.t`. Storing both base and tip blobs is what makes rebases handle cleanly: when a PR is rebased onto a new base but a file's actual contribution is unchanged, cabaret detects this and advances the brain silently (a *rev-update*) without forcing the reviewer to re-read anything.

When the brain doesn't already match the PR's current `(base, tip)` for a file, cabaret shows the reviewer a *diff4* — the diff-of-diffs between the change the reviewer accepted and the change the PR now presents. The reviewer sees only what's genuinely new for them.

### Storage

All cabaret state lives in git refs under `refs/cabaret/...`. Nothing is committed to the working tree. Sync — between devices, or between collaborators who opt in — is plain `git fetch`/`git push` of those refs.

```
refs/cabaret/prs/<n>/
  target           # last-known PR tip (also pins the commit object so GC doesn't reap it)
  base             # last-known merge-base
  meta             # cached PR title, author, labels
  brain/<user>     # this user's brain for PR #<n> — a tree of (base, tip) per path
```

The PR is the unit of organization: every ref about PR #42 lives under `refs/cabaret/prs/42/`, including each reviewer's brain. This matches Iron's per-feature shape, aligns ref lifecycle with PR lifecycle (open → reviewed → archived together), and means cross-PR work from two devices doesn't contend — reviewing PR #42 on the laptop and PR #43 on the desktop touches different refs entirely. Each brain ref is a fast-forward-only chain of commits, one per `accept` action — a free audit log via `git log refs/cabaret/prs/<n>/brain/<me>`. When two devices do accept on the same PR offline, the resulting non-fast-forward is resolved by a three-way merge over the brain tree — per path, blob-SHA-aware.

### `.cabaret/` reserved

The `.cabaret/` directory in-tree is reserved for future repo-scoped configuration: review obligations, team definitions, scrutiny rules — anything that should be PR-reviewable as source. None of this exists in v1; the reservation is so that when it does, it lives where governance review naturally happens.

## CLI surface (sketch)

```
cabaret status <PR>            # what's new for me, per file
cabaret diff <PR>              # show diff4s for changed files
cabaret accept <PR>            # advance brain for everything in the PR
cabaret accept-file <PR> <path>
```

## Tech stack

Cabaret is written in TypeScript across the stack — CLI, future VSCode plugin, future web app — so types for brain entries, diff4s, and PR state are defined once and shared everywhere. The codebase is a pnpm monorepo:

```
packages/
  core/      # brain logic, diff algorithms, types — pure, no I/O
  backend/   # Backend interface + git-transport implementations
  cli/       # the `cabaret` CLI
```

Two architectural rules:

- **`core` does no I/O.** Git operations, GitHub API calls, and filesystem reads all live in `backend`. The brain logic stays testable in isolation and runs unchanged across CLI / plugin / web.
- **The `Backend` interface separates *git transport* from *forge integration*.** Git operations (refs, blobs, trees) have two possible transports: local `git` CLI (for installed users) and GitHub's git-data REST API (for a future web client). Forge-specific operations (listing PRs, posting comments) sit in a separate layer, GitHub-only for now.

Local git operations shell out to `git` rather than using `isomorphic-git` or `nodegit` — the system binary is faster and better-tested.

Type discipline relies on discriminated unions for state, branded primitives (BlobSha is not arbitrary string), `strict: true` + `noUncheckedIndexedAccess`, and zod-style parsing at every I/O boundary.

## Coexistence with edamajutsu

Cabaret is designed to work alongside edamajutsu (a VSCode plugin for jj) without depending on it. Both products share UX idioms — consistent commands, similar status-bar patterns, the same diff viewer style — but not code. Their domains (jj operations vs review state) are distinct, and a shared core would make both harder to evolve.

## Status

Pre-implementation. See [roadmap.md](roadmap.md) for the proposed milestones.

## References

Iron source (Jane Street): https://github.com/janestreet/iron — particularly:

- `hg/brain.mli`, `hg/diff2.mli`, `hg/diff4.mli`, `common/diamond.mli` — brain and diff-of-diffs semantics
- `server/review_manager.ml` — where Iron mutates the brain

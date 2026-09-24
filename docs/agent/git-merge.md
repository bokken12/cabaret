# Git Merge

Notes from the Git Merge conference talks, read for ideas Cabaret could borrow. Only the 2024 and 2025 talks were read, since those are the ones with transcripts available. 2020 does not appear to be on YouTube. The 2013–2022 talks are listed at the end.

## Most Applicable

### Causal Log Ordering (Radicle, 2024)

Radicle stores each collaborative object (issue, patch) as its own commit graph, separate from the source history. Each commit holds one or more operation blobs plus a manifest blob that names the encoding. Its parents are every operation the author had seen when writing it. A topological sort then gives a true partial order: causally related operations are ordered, and concurrent ones are left in an arbitrary but deterministic order. The current state is a fold over the sorted operations. For Cabaret's change log:

- Ordering comes from what each author had actually seen, not from wall-clock timestamps, so clock skew can no longer reorder operations.
- An operation can list the commits it refers to as extra parents. Radicle does this for a patch's code. For Cabaret this could be a `mark` entry's reviewed revision. Fetching the log then fetches those revisions too, and they stay reachable, which covers the GC problem below.
- Each peer writes only under its own git namespace, so no ref ever has two writers. Per-user log refs would turn Cabaret's union merge into plain fetching.

### Keeping Unreferenced Commits Alive

Review state points at tips that later get rebased away. If git garbage-collects those commits, the diff since a user's last review can no longer be computed. Three precedents:

- **jj (2025):** keeps a ref pointing at every visible commit that has no branch.
- **GitButler (2024, 2025):** hides the head of its operation log in an entry of a reflog it controls and keeps rewriting. GC treats reflog entries as roots, but the commits never show up in `git branch` or `git log --all`.
- **Radicle:** the parent trick above.

### The `change-id` Commit Header

jj and GitButler write a random change ID into the commit header, not into a trailer, so it survives amend and rebase. As of 2025 they share the same header with Gerrit. Tools ignore unknown headers. GitHub dropped the header on rebase-merge in 2024, but by 2025 it keeps it because it uses `git replay`. GitLab's server-side rebase still loses it.

This could let Cabaret match a reviewed commit to its rebased successor. Cabaret's tip-based review state may not need that, but it is the emerging standard if per-commit identity is ever needed.

### Headless Merge and Remerge-Diff (Elijah Newren, 2025)

- `git merge-tree` and `git replay` merge and rebase without a worktree or index. They are the reference behaviour for computing the left side of a review diff, merge(last reviewed tip, bases), and for landing without a workspace. gix's merge support is still maturing, and so, as of 2024, was its rebase support.
- `--remerge-diff` shows only what a human changed on top of the automatic merge. This fits reviewing a rebase: Cabaret's review state treats a clean rebase as needing no review, and remerge-diff would show exactly the conflict resolutions that do. It works only on merges, because git does not record what a rebased commit was rebased from. Cabaret knows the old tip, so it could remerge the old tip with the new base and diff that against the new tip.
- Newren's prototype stores conflicts in commit headers, as jj and GitButler do. The open risk is pushing a commit that still contains a conflict. jj refuses to push such commits.

### Policy and Approvals as Git Data (gittuf, 2024)

gittuf keeps an append-only, signed "reference state log" of every ref update, a versioned policy ref (who may write where, with thresholds), and approvals stored as signed attestations. It is a worked example of obligations and approvals living in git and being checked by every client. Cabaret assumes users are not malicious, so this is only a design reference for now.

### Pitfalls

- **Git notes don't scale.** jj stored change IDs and conflict data in git notes and found them "way too slow after a while" even with compaction.
- **Ref count grows.** Gerrit keeps review metadata in git, and its repositories grow faster than those on other forges because of it. With the files ref backend, deleting any ref rewrites all of `packed-refs`, which is over 2GB for one GitLab repository. Archiving or deleting change refs on a big monorepo pays that cost unless the repository uses reftable. In 2024 gix did not support reftable.
- **SSH in gix.** In 2024 gix shelled out to `ssh` for SSH transport. jj moved fetch and push to the `git` subprocess because libgit2 ignored users' SSH config and credential helpers. Check what Cabaret's sync does today.

## Summaries

### 2025

- **Opening Remarks** (Taylor Blau, Pj Metz): logistics only.
- **The Periodic Table of Git** (Matteo Bianchi): a reference site that groups git commands by category and flags which are destructive.
- **The History of GitLens** (Chris Griffing): how the VS Code extension grew to 40M installs. It shells out to git, and its inline blame and CodeLens are the main UI patterns.
- **Native Large Object Support** (Patrick Steinhardt): why git handles big binaries badly, and upstream work on large-object promisor remotes and pluggable object databases.
- **Bundling libgit2 in your Desktop App** (Lita Cho): moving an Electron app from the user's git CLI to embedded libgit2 in Tauri. Version skew and blocking the UI thread were the motivators, and go-git and Gitaly were rejected for lacking real merge and rebase.
- **Genome Sized Repos** (Piyush Acharya): shallow and partial clones plus filter-process to make a 200GB LFS repository usable for contributors.
- **Reimagining Git** (Jacob Stopak): git-sim animations and a 3D game for teaching git.
- **The GitButler CLI** (Scott Chacon): the `but` CLI over virtual branches, with a single `rub` verb for amend, squash and move, an operation log for undo, conflicts stored as trees, and the shared change-id header.
- **Repacking Monorepos** (Taylor Blau): GitHub's move from full repacks to geometric repacking and incremental multi-pack-index chains. Server-side only.
- **Git's New Merge Backend** (Elijah Newren): `merge-tree`, `replay`, remerge-diff and range-diff, built on the ort merge backend, and a prototype interactive rebase that stores conflicts in headers.
- **MergeQueue at Uber Scale** (Dhruva Juloori): speculative CI builds across a tree of possible outcomes. Changes whose build targets don't overlap count as independent and land in parallel, and ML predicts which builds are worth running.
- **Git-Metrics** (Steffen Hiller, Zoran Petrovic): a CLI that reports how a repository's size and composition grow, with forecasts.
- **How Jujutsu Uses Git** (Martin von Zweigbergk): how jj's concepts map onto git. Change-id and conflict headers, keep-alive refs, a "weird root tree" that keeps the trees of a conflict alive, dropping git notes, and importing and exporting refs around every command in colocated repositories.
- **Git in University Education** (Arman Moztarzadeh): how git is taught at UBC.
- **Git Cat Adventures** (Pillippa Pérez Pons): a tour of rerere, reflog, sparse checkout, partial clone, commit-graph and multi-pack-index.
- **From Theory to Git** (Usman Akinyemi): an Outreachy contributor's path into git.
- **Evolving UX, Subversion to Jujutsu** (Fedor Sheremetyev): VCS UX history, arguing for conflicts as data, branches as plumbing and always-on sync. Asked about concurrent edits, the speaker's answer was last write wins.
- **A Serverless Git Server** (Natalie Marleny): libgit2 compiled to WebAssembly on Cloudflare Durable Objects. The browser's `fetch` isn't full duplex, which limits smart-protocol negotiation.
- **SHA-256 Interoperability** (brian m. carlson): status of repositories with a main and a compatibility hash, and the remaining work before git 3.0.

### 2024

- **Scaling Git** (Taylor Blau): multi-pack bitmaps, pseudo-merge bitmaps, cruft packs and incremental multi-pack-index, so maintenance cost scales with new objects rather than repository size.
- **A Gossip Layer and CRDT on Top of Git** (Alexis Sellier, Radicle): peer-to-peer forge. Gossip for discovery, fetch-only replication by tunnelling `upload-pack`, self-certifying identity documents with delegate thresholds, per-peer namespaces, and commit-graph CRDTs.
- **Jujutsu** (Martin von Zweigbergk): a jj demo covering working-copy commits, change IDs, the operation log with undo, first-class conflicts, revsets, and Google's cloud backend at 600M+ commits.
- **State of Libification** (Emily Shaffer): progress on splitting git's logic into a reusable library, with Rust bindings for jj.
- **Credential Helper Protocol** (brian m. carlson): capabilities, explicit auth types for bearer tokens, ephemeral credentials and multi-round auth.
- **libgit2** (Edward Thomson): the project's history and maintenance and funding challenges.
- **Abusing Git for GitButler** (Scott Chacon): virtual branches through an octopus-merged workspace commit, an operation log hidden behind a reflog, change-id headers (GitHub stripped them on rebase-merge), and deferred-conflict rebases.
- **The Reftable Backend** (Patrick Steinhardt): why the loose and packed-refs backends break at scale, and how reftable's geometrically compacted, append-only tables give atomic multi-ref updates and cheap deletes.
- **git-filter-repo** (Elijah Newren): history rewriting with fast-export and fast-import, and why filter-branch and BFG fell short.
- **AI for Monorepo Performance** (GerritForge): a reinforcement-learning agent that chooses repacks and bitmap rebuilds from live metrics, needed because Gerrit keeps review data in git.
- **Gitoxide** (Sebastian Thiel): gix's goals and status. As of 2024, merge, rebase, push, reftable and native SSH were missing or only just arriving.
- **Securing Repositories with gittuf** (Aditya Sirish A Yelgundhalli): a signed reference state log, a versioned policy ref and approval attestations, all verifiable without trusting the server.
- **Marrying Meta SCM with Git** (Muir Manders, Rajiv Sharma): not read (no transcript fetched).

### Not Yet Read

These years have talks on YouTube, but YouTube rate-limited fetching their transcripts. Titles that look worth a later read:

- **2022:** Jujutsu: A Git-Compatible VCS; Git Internals: a Database Perspective; Improving git status performance in Uber's Go monorepo; Build-aware sparse checkouts.
- **2019:** The what, how and why of scaling repositories; Git & version control in the enterprise.
- **2018:** Annotating diffs; Automating the non-automatable: merging refactored code; Git driven refactoring.
- **2017:** Scaling Mercurial at Facebook; What's Wrong With Git?; Trust But Verify.
- **2016:** Change Needs Management; From CLI to GUI.
- **2015:** Git at Google (Dave Borowitz).
- **2013:** git-imerge (Michael Haggerty).

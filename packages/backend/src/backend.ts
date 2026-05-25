import type { BrainEntry, CommitSha, FileState, PrNumber, UserId } from '@cabaret/core';

/**
 * Metadata about a PR — what the forge tells us, plus the resolved commits
 * needed to compute diffs. `baseCommit` is the *merge-base* of the PR head
 * and the base branch, not just the tip of the base branch — this matches
 * what GitHub shows in its "Files changed" view.
 */
export type PrInfo = {
  readonly number: PrNumber;
  readonly title: string;
  readonly author: string;
  readonly baseRef: string;
  readonly baseCommit: CommitSha;
  readonly tipCommit: CommitSha;
  readonly url: string;
};

/**
 * The Backend interface separates *git transport* (refs, blobs, trees) from
 * *forge integration* (listing PRs, reading PR metadata). Both halves can
 * have multiple implementations:
 *
 *   - Local-git transport: shells out to the system `git` CLI.
 *   - GitHub REST transport: hits GitHub's git-data API (future, for web).
 *
 * The forge layer is GitHub-only today. We do not abstract it across forges
 * until there is a real second forge to integrate.
 *
 * `core` does no I/O; everything that touches a file, a process, or the
 * network lives behind this interface.
 */
export interface Backend {
  /** Who is the local user? Derived from git config or similar. */
  currentUser(): Promise<UserId>;

  /** Forge: read metadata about a PR. */
  getPrInfo(pr: PrNumber): Promise<PrInfo>;

  /**
   * Git: enumerate files added or modified between the PR's base and tip
   * trees, with blob SHAs. TODO: include deletes and renames.
   */
  getChangedFiles(pr: PrNumber): Promise<readonly FileState[]>;

  /**
   * Read a reviewer's brain for a PR. Returns an empty list if no brain
   * exists yet (e.g. the reviewer has never touched this PR).
   */
  readBrain(user: UserId, pr: PrNumber): Promise<readonly BrainEntry[]>;

  /**
   * Replace a reviewer's brain for a PR with `entries`. Concurrency
   * semantics (e.g. fast-forward via CAS on the brain ref) are an
   * implementation detail of the transport.
   */
  writeBrain(user: UserId, pr: PrNumber, entries: readonly BrainEntry[]): Promise<void>;
}

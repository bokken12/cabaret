import type {
  BlobSha,
  BrainEntry,
  CommitSha,
  Path,
  PrNumber,
  UserId,
} from '@cabaret/core';

/**
 * Metadata about a PR — what the forge tells us, plus the resolved commits
 * needed to compute diffs.
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
 * A single file changed by a PR. `baseBlob` is null for files added by the
 * PR (i.e. absent from the base tree).
 */
export type ChangedFile = {
  readonly path: Path;
  readonly baseBlob: BlobSha | null;
  readonly tipBlob: BlobSha;
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

  /** Forge + git: list files changed between PR base and tip, with blob SHAs. */
  getChangedFiles(pr: PrNumber): Promise<readonly ChangedFile[]>;

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

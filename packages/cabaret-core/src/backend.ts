import type { Branded } from "cabaret-util";

/** A full (non-abbreviated) git commit hash. Obtain via `parseCommitHash` or `Backend.resolve`. */
export type CommitHash = Branded<string, "CommitHash">;

const COMMIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function parseCommitHash(raw: string): CommitHash {
  if (!COMMIT_HASH.test(raw)) {
    throw new Error(`not a commit hash: ${JSON.stringify(raw)}`);
  }
  return raw as CommitHash;
}

/**
 * The operations Cabaret needs from a version-control backend.
 * The primary implementation (`cabaret-node`) shells out to a local git.
 */
export interface Backend {
  /** Resolve a revision expression (e.g. "HEAD", a branch name) to a commit. */
  resolve(revision: string): Promise<CommitHash>;

  /** Paths changed between two commits, relative to the repository root. */
  changedFiles(base: CommitHash, tip: CommitHash): Promise<readonly string[]>;

  /** The contents of the file at `path` in `commit`. */
  readFile(commit: CommitHash, path: string): Promise<string>;
}

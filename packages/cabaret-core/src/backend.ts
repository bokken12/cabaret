import type { Branded } from "cabaret-util";

/** A full (non-abbreviated) git commit hash. Obtain via `parseCommitHash`. */
export type CommitHash = Branded<string, "CommitHash">;

const COMMIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function parseCommitHash(raw: string): CommitHash {
  if (!COMMIT_HASH.test(raw)) {
    throw new Error(`not a commit hash: ${JSON.stringify(raw)}`);
  }
  return raw as CommitHash;
}

/** A git branch or ref name (e.g. "main"). Obtain via `parseRefName`. */
export type RefName = Branded<string, "RefName">;

// The forbidden-character subset of `git check-ref-format`: control chars and
// space, the glob/revision metacharacters, `..`, `@{`, a bare `@`, leading or
// doubled slashes, and `.`/`.lock` at the very end.
// biome-ignore lint/suspicious/noControlCharactersInRegex: git ref names forbid control characters, so we must match them.
const REF_NAME_FORBIDDEN = /[\x00-\x20~^:?*[\\\x7f]|\.\.|@\{|^@$|^\/|\/\/|\.lock$|\.$/;

export function parseRefName(raw: string): RefName {
  if (raw === "" || REF_NAME_FORBIDDEN.test(raw)) {
    throw new Error(`not a valid ref name: ${JSON.stringify(raw)}`);
  }
  return raw as RefName;
}

/** One action recorded in a change's log. */
export interface LogEntry {
  /** Unix timestamp (seconds) at which the entry was created. */
  readonly timestamp: number;
  /** Who wrote the entry. */
  readonly user: string;
  /** The action taken, e.g. `set-parent main`. */
  readonly action: string;
}

/**
 * Render an entry as its log line. The line is space-separated, so the user
 * must be a single nonempty word and the action a single nonempty line.
 */
export function formatLogEntry({ timestamp, user, action }: LogEntry): string {
  if (!Number.isInteger(timestamp) || user === "" || /\s/.test(user) || action === "" || /[\r\n]/.test(action)) {
    throw new Error(`malformed log entry: ${JSON.stringify({ timestamp, user, action })}`);
  }
  return `${timestamp} ${user} ${action}\n`;
}

/**
 * The operations Cabaret needs from a version-control backend.
 * The primary implementation (`cabaret-node`) shells out to a local git.
 */
export interface Backend {
  /** The name of the branch checked out in the working tree. */
  currentBranch(): Promise<RefName>;

  /** The identity attributed to log entries this user writes (git `user.email`). */
  currentUser(): Promise<string>;

  /**
   * The raw text of `change`'s log. A change whose log ref does not exist yet
   * has the empty log, so no initialization step is needed; no other parsing
   * or validation is performed here.
   */
  readLog(change: RefName): Promise<string>;

  /** Append `entry` to `change`'s log, creating the log if needed. */
  appendLog(change: RefName, entry: LogEntry): Promise<void>;
}

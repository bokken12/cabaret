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

/** A user identity (git `user.email`). Obtain via `userName`. */
export type UserName = Branded<string, "UserName">;

/** Tag `raw` as a user name. Applies no validation. */
export function userName(raw: string): UserName {
  return raw as UserName;
}

/** An action that can be recorded in a change's log. */
export type LogAction = { readonly kind: "set-parent"; readonly parent: RefName };

/**
 * Render an action as its log form, e.g. `set-parent main`. Always a single
 * nonempty line: ref names cannot contain whitespace or control characters.
 */
export function formatLogAction(action: LogAction): string {
  switch (action.kind) {
    case "set-parent":
      return `set-parent ${action.parent}`;
  }
}

/** Parse the log form produced by `formatLogAction`. */
export function parseLogAction(raw: string): LogAction {
  const space = raw.indexOf(" ");
  const [kind, rest] = space === -1 ? [raw, ""] : [raw.slice(0, space), raw.slice(space + 1)];
  switch (kind) {
    case "set-parent":
      return { kind, parent: parseRefName(rest) };
    default:
      throw new Error(`unknown log action: ${JSON.stringify(raw)}`);
  }
}

/** One action recorded in a change's log. */
export interface LogEntry {
  /** Unix timestamp (milliseconds) at which the entry was created. */
  readonly timestamp: number;
  /** Who wrote the entry. */
  readonly user: UserName;
  /** The action taken. */
  readonly action: LogAction;
}

/**
 * Render an entry as its log line. The line is space-separated and starts
 * with a decimal timestamp, so the user must be a single nonempty word and
 * the timestamp a nonnegative safe integer.
 */
export function formatLogEntry({ timestamp, user, action }: LogEntry): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || user === "" || /\s/.test(user)) {
    throw new Error(`malformed log entry: ${JSON.stringify({ timestamp, user, action })}`);
  }
  return `${timestamp} ${user} ${formatLogAction(action)}\n`;
}

/** Parse one log line (without its trailing newline), inverting `formatLogEntry`. */
export function parseLogEntry(line: string): LogEntry {
  const [, rawTimestamp, user, action] = /^(\d+) (\S+) (.+)$/.exec(line) ?? [];
  const timestamp = Number(rawTimestamp);
  if (user === undefined || action === undefined || !Number.isSafeInteger(timestamp)) {
    throw new Error(`malformed log line: ${JSON.stringify(line)}`);
  }
  return { timestamp, user: userName(user), action: parseLogAction(action) };
}

/** Parse a whole log: a sequence of newline-terminated `formatLogEntry` lines. */
export function parseLog(text: string): readonly LogEntry[] {
  if (text === "") {
    return [];
  }
  if (!text.endsWith("\n")) {
    throw new Error("malformed log: missing trailing newline");
  }
  return text.slice(0, -1).split("\n").map(parseLogEntry);
}

/**
 * The operations Cabaret needs from a version-control backend.
 * The primary implementation (`cabaret-node`) shells out to a local git.
 */
export interface Backend {
  /** The name of the branch checked out in the working tree. */
  currentBranch(): Promise<RefName>;

  /** The identity attributed to log entries this user writes. */
  currentUser(): Promise<UserName>;

  /**
   * The entries of `change`'s log, oldest first. A change whose log ref does
   * not exist yet has the empty log, so no initialization step is needed.
   */
  readLog(change: RefName): Promise<readonly LogEntry[]>;

  /** Append `entry` to `change`'s log, creating the log if needed. */
  appendLog(change: RefName, entry: LogEntry): Promise<void>;
}

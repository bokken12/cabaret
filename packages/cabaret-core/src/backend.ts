import type { Branded } from "cabaret-util";
import { z } from "zod";

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

/** A repository-relative file path, as named in diffs. Obtain via `parseFilePath`. */
export type FilePath = Branded<string, "FilePath">;

export function parseFilePath(raw: string): FilePath {
  if (raw === "" || raw.includes("\0")) {
    throw new Error(`not a valid file path: ${JSON.stringify(raw)}`);
  }
  return raw as FilePath;
}

/** A user identity (git `user.email`). Obtain via `userName`. */
export type UserName = Branded<string, "UserName">;

/** Tag `raw` as a user name. Applies no validation. */
export function userName(raw: string): UserName {
  return raw as UserName;
}

/** An action that can be recorded in a change's log. */
export type LogAction =
  | { readonly kind: "set-parent"; readonly parent: RefName }
  | { readonly kind: "set-base"; readonly base: CommitHash }
  | { readonly kind: "review"; readonly file: FilePath; readonly base: CommitHash; readonly tip: CommitHash }
  | { readonly kind: "forget"; readonly file: FilePath };

/** One action recorded in a change's log. */
export interface LogEntry {
  /** Unix timestamp (milliseconds) at which the entry was created. */
  readonly timestamp: number;
  /** Who wrote the entry. */
  readonly user: UserName;
  /** The action taken. */
  readonly action: LogAction;
}

const LogActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set-parent"), parent: z.string().transform(parseRefName) }),
  z.object({ kind: z.literal("set-base"), base: z.string().transform(parseCommitHash) }),
  z.object({
    kind: z.literal("review"),
    file: z.string().transform(parseFilePath),
    base: z.string().transform(parseCommitHash),
    tip: z.string().transform(parseCommitHash),
  }),
  z.object({ kind: z.literal("forget"), file: z.string().transform(parseFilePath) }),
]) satisfies z.ZodType<LogAction>;

/**
 * The log's wire format: entries are stored as this schema's JSON, one object
 * per line, keys in shape order. `satisfies` has the compiler verify that the
 * schema parses to exactly `LogEntry`.
 */
const LogEntrySchema = z.object({
  timestamp: z.int().nonnegative(),
  user: z.string().min(1).transform(userName),
  action: LogActionSchema,
}) satisfies z.ZodType<LogEntry>;

/**
 * Render an entry as its log line. Re-parsing through the schema validates
 * the entry and canonicalizes key order; `JSON.stringify` escapes any
 * newlines, so the result is always a single line.
 */
export function formatLogEntry(entry: LogEntry): string {
  return `${JSON.stringify(LogEntrySchema.parse(entry))}\n`;
}

/** Parse one log line (without its trailing newline), inverting `formatLogEntry`. */
export function parseLogEntry(line: string): LogEntry {
  try {
    return LogEntrySchema.parse(JSON.parse(line));
  } catch (cause) {
    throw new Error(`malformed log line: ${JSON.stringify(line)}`, { cause });
  }
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

  /** Resolve `revision` (a ref name, hash prefix, `HEAD~1`, …) to a full commit hash. */
  resolveCommit(revision: string): Promise<CommitHash>;

  /** The commit branch `branch` points at, or undefined if it does not exist. */
  branchTip(branch: RefName): Promise<CommitHash | undefined>;

  /** Create branch `name` at `commit`, failing if the branch already exists. */
  createBranch(name: RefName, commit: CommitHash): Promise<void>;

  /** The last revision shared between branches `a` and `b`, as `git merge-base`. */
  mergeBase(a: RefName, b: RefName): Promise<CommitHash>;

  /** Whether `ancestor` is reachable from `descendant`, as `git merge-base --is-ancestor`. */
  isAncestor(ancestor: CommitHash, descendant: CommitHash): Promise<boolean>;

  /**
   * Rebase branch `change` onto `onto`, replaying only the commits after
   * `from`, as `git rebase --onto`. Checks out `change` as a side effect. On
   * conflict the rebase is left in progress for the user to resolve with git.
   */
  rebaseOnto(change: RefName, from: CommitHash, onto: CommitHash): Promise<void>;

  /** The `git diff` of `file` from commit `base` to commit `tip`. */
  diffFile(base: CommitHash, tip: CommitHash, file: FilePath): Promise<string>;

  /**
   * The entries of `change`'s log, oldest first. A change whose log ref does
   * not exist yet has the empty log, so no initialization step is needed.
   */
  readLog(change: RefName): Promise<readonly LogEntry[]>;

  /** Atomically append `entries` to `change`'s log, creating the log if needed. */
  appendLog(change: RefName, entries: readonly LogEntry[]): Promise<void>;
}

/**
 * The parent set by the `set-parent` entry with the greatest timestamp, if
 * any. Union-merged logs interleave concurrent entries in arbitrary order, so
 * the timestamp, not log position, decides which entry is current.
 */
export function currentParent(entries: readonly LogEntry[]): RefName | undefined {
  let parent: RefName | undefined;
  let latest = -1;
  for (const { timestamp, action } of entries) {
    if (action.kind === "set-parent" && timestamp >= latest) {
      latest = timestamp;
      parent = action.parent;
    }
  }
  return parent;
}

/**
 * The base recorded by the `set-base` entry with the greatest timestamp, if
 * any. Union-merged logs interleave concurrent entries in arbitrary order, so
 * the timestamp, not log position, decides which entry is current.
 */
export function currentBase(entries: readonly LogEntry[]): CommitHash | undefined {
  let base: CommitHash | undefined;
  let latest = -1;
  for (const { timestamp, action } of entries) {
    if (action.kind === "set-base" && timestamp >= latest) {
      latest = timestamp;
      base = action.base;
    }
  }
  return base;
}

/** The endpoints of a diff a reviewer has reviewed. */
export interface ReviewedDiff {
  readonly base: CommitHash;
  readonly tip: CommitHash;
}

/**
 * What `user` knows of each file in a change — their brain: the diff they
 * most recently reviewed, per file. For each file the entry with the greatest
 * timestamp wins (union-merged logs interleave concurrent entries in
 * arbitrary order), and a winning `forget` erases the file's knowledge.
 */
export function brain(entries: readonly LogEntry[], user: UserName): ReadonlyMap<FilePath, ReviewedDiff> {
  const latest = new Map<FilePath, { timestamp: number; reviewed?: ReviewedDiff }>();
  for (const { timestamp, user: author, action } of entries) {
    if (author !== user || (action.kind !== "review" && action.kind !== "forget")) {
      continue;
    }
    const prev = latest.get(action.file);
    if (prev !== undefined && prev.timestamp > timestamp) {
      continue;
    }
    latest.set(
      action.file,
      action.kind === "review" ? { timestamp, reviewed: { base: action.base, tip: action.tip } } : { timestamp },
    );
  }
  const known = new Map<FilePath, ReviewedDiff>();
  for (const [file, { reviewed }] of latest) {
    if (reviewed !== undefined) {
      known.set(file, reviewed);
    }
  }
  return known;
}

/**
 * The base of `change`: the revision its diff is computed against. `entries`
 * must be `change`'s log; taking it explicitly lets callers derive base and
 * brain from one snapshot of the log.
 *
 * A change is its base plus its own commits, so the base is always an
 * ancestor of the change's tip. Two candidates satisfy that invariant and
 * each covers the other's blind spot, so we take whichever reaches further
 * into the change's history:
 *
 * - The stored base (the log's latest `set-base`) goes stale when the change
 *   is rewritten outside Cabaret: its commits leave the change's history, so
 *   it stops being an ancestor of the tip and is discarded.
 * - The derived base (`merge-base` with the parent) goes stale when the
 *   parent is rewritten while the change is not: it slides back to where the
 *   old and new parent histories diverge, and the stored base — recording
 *   what the change was actually built on — wins as the deeper candidate.
 */
export async function changeBase(backend: Backend, change: RefName, entries: readonly LogEntry[]): Promise<CommitHash> {
  const parent = currentParent(entries);
  if (parent === undefined) {
    throw new Error(`change has no parent: ${JSON.stringify(change)}`);
  }
  const derived = await backend.mergeBase(parent, change);
  const stored = currentBase(entries);
  if (stored === undefined || stored === derived) {
    return derived;
  }
  const tip = await backend.resolveCommit(`refs/heads/${change}`);
  if (!(await backend.isAncestor(stored, tip))) {
    return derived;
  }
  if (await backend.isAncestor(derived, stored)) {
    return stored;
  }
  if (await backend.isAncestor(stored, derived)) {
    return derived;
  }
  // Both are ancestors of the tip but on unrelated lines (the change merged
  // history the stored base cannot see). No principled winner; make the user
  // declare one by rebasing.
  throw new Error(
    `base of ${JSON.stringify(change)} is ambiguous: stored base ${stored} and ` +
      `merge-base ${derived} with parent ${JSON.stringify(parent)} are unrelated; rebase to resolve`,
  );
}

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

/** A unix timestamp in milliseconds. Obtain via `timestampMs`. */
export type TimestampMs = Branded<number, "TimestampMs">;

export function timestampMs(raw: number): TimestampMs {
  if (!Number.isSafeInteger(raw) || raw < 0) {
    throw new Error(`not a millisecond timestamp: ${raw}`);
  }
  return raw as TimestampMs;
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
  | { readonly kind: "set-owner"; readonly owner: UserName }
  | { readonly kind: "review"; readonly file: FilePath; readonly base: CommitHash; readonly tip: CommitHash }
  | { readonly kind: "forget"; readonly file: FilePath }
  | { readonly kind: "land"; readonly merge: CommitHash };

/** One action recorded in a change's log. */
export interface LogEntry {
  /** When the entry was created. */
  readonly timestamp: TimestampMs;
  /** Who wrote the entry. */
  readonly user: UserName;
  /** The action taken. */
  readonly action: LogAction;
}

const LogActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set-parent"), parent: z.string().transform(parseRefName) }),
  z.object({ kind: z.literal("set-base"), base: z.string().transform(parseCommitHash) }),
  z.object({ kind: z.literal("set-owner"), owner: z.string().min(1).transform(userName) }),
  z.object({
    kind: z.literal("review"),
    file: z.string().transform(parseFilePath),
    base: z.string().transform(parseCommitHash),
    tip: z.string().transform(parseCommitHash),
  }),
  z.object({ kind: z.literal("forget"), file: z.string().transform(parseFilePath) }),
  z.object({ kind: z.literal("land"), merge: z.string().transform(parseCommitHash) }),
]) satisfies z.ZodType<LogAction>;

/**
 * The log's wire format: entries are stored as this schema's JSON, one object
 * per line, keys in shape order. `satisfies` has the compiler verify that the
 * schema parses to exactly `LogEntry`.
 */
const LogEntrySchema = z.object({
  timestamp: z.number().transform(timestampMs),
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
 * The commit-message trailer marking a merge as landing a change. Reviewers
 * of the parent skip the diff such a merge brings in: it was reviewed in the
 * child, under the child's own log.
 */
export const LAND_TRAILER = "Cabaret-Landed";

/** The message for the merge commit that lands `change`. */
export function landMessage(change: RefName): string {
  return `Land ${change}\n\n${LAND_TRAILER}: ${change}\n`;
}

/** A merge commit that landed a change, and the parent tip it landed onto. */
export interface LandMerge {
  readonly commit: CommitHash;
  readonly onto: CommitHash;
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

  /**
   * Create the merge commit recording `tip` merging into branch `into`:
   * parents `onto` then `tip`, carrying `message`, with `tip`'s tree — sound
   * only because `onto` must be an ancestor of `tip`. Advances `into` from
   * `onto` to the new commit, failing if `into` no longer points at `onto`,
   * and carries a checked-out `into`'s working tree along.
   */
  merge(into: RefName, onto: CommitHash, tip: CommitHash, message: string): Promise<CommitHash>;

  /**
   * The merges carrying the `LAND_TRAILER` trailer on the first-parent chain
   * from `base` to `tip`, oldest first.
   */
  landMerges(base: CommitHash, tip: CommitHash): Promise<readonly LandMerge[]>;

  /** The contents of `file` at `commit`, or undefined if no file exists there. */
  readFile(commit: CommitHash, file: FilePath): Promise<string | undefined>;

  /**
   * The file paths that differ between `base` and `tip`, as `git diff
   * --name-only`. A moved file counts as a delete plus an add, so each path
   * names the same file on both sides; submodules are not files and are
   * never listed.
   */
  changedFiles(base: CommitHash, tip: CommitHash): Promise<readonly FilePath[]>;

  /**
   * The entries of `change`'s log, oldest first. A change whose log ref does
   * not exist yet has the empty log, so no initialization step is needed.
   */
  readLog(change: RefName): Promise<readonly LogEntry[]>;

  /** Atomically append `entries` to `change`'s log, creating the log if needed. */
  appendLog(change: RefName, entries: readonly LogEntry[]): Promise<void>;
}

/**
 * The `kind`-actioned entry with the greatest timestamp, if any. Union-merged
 * logs interleave concurrent entries in arbitrary order, so the timestamp,
 * not log position, decides which entry is current.
 */
function latestAction<K extends LogAction["kind"]>(
  entries: readonly LogEntry[],
  kind: K,
): Extract<LogAction, { kind: K }> | undefined {
  let found: Extract<LogAction, { kind: K }> | undefined;
  let latest = -1;
  for (const { timestamp, action } of entries) {
    if (action.kind === kind && timestamp >= latest) {
      latest = timestamp;
      found = action as Extract<LogAction, { kind: K }>;
    }
  }
  return found;
}

/** Fail unless `change` has been created: a change exists exactly when its log is nonempty. */
export function assertChangeExists(change: RefName, entries: readonly LogEntry[]): void {
  if (entries.length === 0) {
    throw new Error(`change does not exist: ${JSON.stringify(change)}; run \`cabaret create\` first`);
  }
}

/** The parent from the log's latest `set-parent`; `create` starts every log with one, so a missing parent is an error. */
export function currentParent(change: RefName, entries: readonly LogEntry[]): RefName {
  assertChangeExists(change, entries);
  const action = latestAction(entries, "set-parent");
  if (action === undefined) {
    throw new Error(`change has no parent: ${JSON.stringify(change)}`);
  }
  return action.parent;
}

/** The base from the log's latest `set-base`; `create` starts every log with one, so a missing base is an error. */
export function currentBase(change: RefName, entries: readonly LogEntry[]): CommitHash {
  assertChangeExists(change, entries);
  const action = latestAction(entries, "set-base");
  if (action === undefined) {
    throw new Error(`change has no base: ${JSON.stringify(change)}`);
  }
  return action.base;
}

/** The owner from the log's latest `set-owner`; `create` starts every log with one, so a missing owner is an error. */
export function currentOwner(change: RefName, entries: readonly LogEntry[]): UserName {
  assertChangeExists(change, entries);
  const action = latestAction(entries, "set-owner");
  if (action === undefined) {
    throw new Error(`change has no owner: ${JSON.stringify(change)}`);
  }
  return action.owner;
}

/** The merge that landed the change, or undefined if it has not landed. */
export function landedMerge(entries: readonly LogEntry[]): CommitHash | undefined {
  return latestAction(entries, "land")?.merge;
}

/**
 * Fail if `change` has landed. Landing is final: the change's code is frozen
 * in its parent, so entries that would alter what there is to review may no
 * longer be written. Review state is not code, so `review` and `forget` stay
 * allowed and do not call this.
 */
export function assertNotLanded(change: RefName, entries: readonly LogEntry[]): void {
  const merge = landedMerge(entries);
  if (merge !== undefined) {
    throw new Error(`change has landed: ${JSON.stringify(change)} (merge ${merge})`);
  }
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
  const latest = new Map<FilePath, { timestamp: TimestampMs; reviewed?: ReviewedDiff }>();
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
  // Once the change lands, its parent's history contains the change itself,
  // so the merge-base slides to the change's own tip and would erase its
  // diff. `land` pins the base, and a landed change is frozen, so the stored
  // base stays correct forever.
  if (landedMerge(entries) !== undefined) {
    return currentBase(change, entries);
  }
  const parent = currentParent(change, entries);
  const derived = await backend.mergeBase(parent, change);
  const stored = currentBase(change, entries);
  if (stored === derived) {
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

/** One contiguous span of a change's history that a reviewer must review. */
export interface DiffSegment {
  readonly start: CommitHash;
  readonly end: CommitHash;
}

/**
 * The spans of `base`..`tip` left for a reviewer to review, oldest first.
 *
 * Land merges on the first-parent chain split the history into segments: the
 * diff each merge brings in was already reviewed in the landed child, so what
 * needs review is base → first land's onto, then each land merge → the next
 * land's onto, and finally the last land merge → tip. A segment a land merge
 * jumps over entirely (its start is its end) is dropped.
 *
 * `reviewedTip`, when given, is the tip of the reviewer's brain for a review
 * whose base matches `base` (a moved base invalidates segment endpoints, so
 * callers handle that case separately): segments the reviewer has already
 * reviewed past are dropped, and the segment containing `reviewedTip` resumes
 * from it.
 */
export async function reviewSegments(
  backend: Backend,
  base: CommitHash,
  tip: CommitHash,
  reviewedTip?: CommitHash,
): Promise<readonly DiffSegment[]> {
  const segments: DiffSegment[] = [];
  let start = base;
  for (const { commit, onto } of await backend.landMerges(base, tip)) {
    if (start !== onto) {
      segments.push({ start, end: onto });
    }
    start = commit;
  }
  if (start !== tip) {
    segments.push({ start, end: tip });
  }
  if (reviewedTip === undefined) {
    return segments;
  }
  const remaining: DiffSegment[] = [];
  for (const segment of segments) {
    if (await backend.isAncestor(segment.end, reviewedTip)) {
      continue;
    }
    const inside =
      (await backend.isAncestor(segment.start, reviewedTip)) && (await backend.isAncestor(reviewedTip, segment.end));
    remaining.push(inside ? { start: reviewedTip, end: segment.end } : segment);
  }
  return remaining;
}

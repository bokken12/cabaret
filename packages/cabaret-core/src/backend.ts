import type { Branded } from "cabaret-util";
import { z } from "zod";
import { UserError } from "./error.js";

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
// space, the glob/revision metacharacters, `..`, `@{`, a bare `@`, a component
// starting with `.`, a component ending in `.lock`, leading/trailing/doubled
// slashes, and a trailing `.` on the whole name.
// biome-ignore lint/suspicious/noControlCharactersInRegex: git ref names forbid control characters, so we must match them.
const REF_NAME_FORBIDDEN = /[\x00-\x20~^:?*[\\\x7f]|\.\.|@\{|^@$|(?:^|\/)\.|\/\/|\.lock(?:$|\/)|^\/|\/$|\.$/;

export function parseRefName(raw: string): RefName {
  if (raw === "" || REF_NAME_FORBIDDEN.test(raw)) {
    throw new UserError(`not a valid ref name: ${JSON.stringify(raw)}`);
  }
  return raw as RefName;
}

/** A repository-relative file path, as named in diffs. Obtain via `parseFilePath`. */
export type FilePath = Branded<string, "FilePath">;

export function parseFilePath(raw: string): FilePath {
  if (raw === "" || raw.includes("\0")) {
    throw new UserError(`not a valid file path: ${JSON.stringify(raw)}`);
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

/** A forge repository locator, e.g. "github.com/test-org/widgets". Obtain via `parseForgeLocator`. */
export type ForgeLocator = Branded<string, "ForgeLocator">;

export function parseForgeLocator(raw: string): ForgeLocator {
  if (raw === "") {
    throw new Error("forge locator must be nonempty");
  }
  return raw as ForgeLocator;
}

/** A change's number on a forge: its pull-request (GitHub) or merge-request (GitLab) number. Obtain via `forgeChangeId`. */
export type ForgeChangeId = Branded<number, "ForgeChangeId">;

export function forgeChangeId(raw: number): ForgeChangeId {
  if (!Number.isSafeInteger(raw) || raw <= 0) {
    throw new UserError(`not a forge change number: ${raw}`);
  }
  return raw as ForgeChangeId;
}

/**
 * Where a forge-synced entry came from. An entry with a source mirrors the
 * forge — an import, or an observation a push records — while one without
 * originated locally; syncing compares the forge against the last
 * source-bearing entry, never against local intent. `id` names the forge-side
 * object the entry is a version of, when the forge keeps one (a comment,
 * say), so imports of the same object recognize each other.
 */
export interface ForgeSource {
  readonly forge: ForgeLocator;
  readonly id?: string | undefined;
}

/** An action that can be recorded in a change's log. */
export type LogAction =
  | { readonly kind: "set-parent"; readonly parent: RefName }
  | { readonly kind: "set-base"; readonly base: CommitHash }
  | { readonly kind: "set-owner"; readonly owner: UserName }
  | { readonly kind: "set-forge"; readonly forge: ForgeLocator; readonly id: ForgeChangeId }
  | { readonly kind: "add-reviewer"; readonly reviewer: UserName }
  | { readonly kind: "remove-reviewer"; readonly reviewer: UserName }
  | { readonly kind: "review"; readonly file: FilePath; readonly base: CommitHash; readonly tip: CommitHash }
  | { readonly kind: "forget"; readonly file: FilePath }
  | { readonly kind: "land"; readonly merge: CommitHash; readonly tip?: CommitHash | undefined }
  /** `edits` names the `commentHash` of the entry this comment supersedes: versions of one comment group through it, and the greatest timestamp is displayed. */
  | { readonly kind: "comment"; readonly text: string; readonly edits?: string | undefined };

/** One action recorded in a change's log. */
export interface LogEntry {
  /** When the entry was created. */
  readonly timestamp: TimestampMs;
  /** Who wrote the entry. */
  readonly user: UserName;
  /** The forge state the entry mirrors, for one that did not originate locally. */
  readonly source?: ForgeSource | undefined;
  /** The action taken. */
  readonly action: LogAction;
}

const ForgeSourceSchema = z.object({
  forge: z.string().transform(parseForgeLocator),
  id: z.string().min(1).optional(),
}) satisfies z.ZodType<ForgeSource>;

const LogActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set-parent"), parent: z.string().transform(parseRefName) }),
  z.object({ kind: z.literal("set-base"), base: z.string().transform(parseCommitHash) }),
  z.object({ kind: z.literal("set-owner"), owner: z.string().min(1).transform(userName) }),
  z.object({
    kind: z.literal("set-forge"),
    forge: z.string().transform(parseForgeLocator),
    id: z.number().transform(forgeChangeId),
  }),
  z.object({ kind: z.literal("add-reviewer"), reviewer: z.string().min(1).transform(userName) }),
  z.object({ kind: z.literal("remove-reviewer"), reviewer: z.string().min(1).transform(userName) }),
  z.object({
    kind: z.literal("review"),
    file: z.string().transform(parseFilePath),
    base: z.string().transform(parseCommitHash),
    tip: z.string().transform(parseCommitHash),
  }),
  z.object({ kind: z.literal("forget"), file: z.string().transform(parseFilePath) }),
  z.object({
    kind: z.literal("land"),
    merge: z.string().transform(parseCommitHash),
    tip: z.string().transform(parseCommitHash).optional(),
  }),
  z.object({ kind: z.literal("comment"), text: z.string().min(1), edits: z.string().min(1).optional() }),
]) satisfies z.ZodType<LogAction>;

/**
 * The log's wire format: entries are stored as this schema's JSON, one object
 * per line, keys in shape order. `satisfies` has the compiler verify that the
 * schema parses to exactly `LogEntry`.
 */
const LogEntrySchema = z.object({
  timestamp: z.number().transform(timestampMs),
  user: z.string().min(1).transform(userName),
  source: ForgeSourceSchema.optional(),
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
 * Total order on log entries: by timestamp, then by serialized line. Merged
 * logs hold concurrent entries from many machines, so every read that picks a
 * "latest" entry must break timestamp ties on content, never on log position,
 * for all machines to agree; only byte-identical entries compare equal.
 */
export function compareLogEntries(a: LogEntry, b: LogEntry): number {
  if (a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }
  const left = formatLogEntry(a);
  const right = formatLogEntry(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Merge two logs of one change: the union of their entries, deduplicated by
 * serialized line and in `compareLogEntries` order. A function of the entry
 * sets alone, so machines merging in any order or grouping converge on
 * byte-identical logs.
 */
export function mergeLogs(a: readonly LogEntry[], b: readonly LogEntry[]): readonly LogEntry[] {
  const byLine = new Map<string, LogEntry>();
  for (const entry of [...a, ...b]) {
    byLine.set(formatLogEntry(entry), entry);
  }
  return [...byLine.values()].sort(compareLogEntries);
}

/**
 * The commit-message trailer marking a commit as landing a change. Reviewers
 * of the parent skip the diff such a commit brings in: it was reviewed in the
 * child, under the child's own log.
 */
export const LAND_TRAILER = "Cabaret-Landed";

/** The title line of the commit that lands `change`. */
export function landTitle(change: RefName): string {
  return `Land ${change}`;
}

/** The trailer line marking the commit that lands `change`. */
export function landTrailer(change: RefName): string {
  return `${LAND_TRAILER}: ${change}`;
}

/** The message for the commit that lands `change`. */
export function landMessage(change: RefName): string {
  return `${landTitle(change)}\n\n${landTrailer(change)}\n`;
}

/** A commit that landed a change, and the parent tip it landed onto. */
export interface LandMerge {
  readonly commit: CommitHash;
  readonly onto: CommitHash;
}

/** The commit that landed a merged forge change on its parent branch. */
export interface ForgeMerge {
  readonly commit: CommitHash;
  /** 2 for a true merge, whose second parent is the reviewed head; 1 for a squash or rebase, whose commit descends from no reviewed history. */
  readonly parents: number;
}

/** A change as a forge holds it: a pull request (GitHub) or merge request (GitLab). */
export interface ForgeChange {
  readonly id: ForgeChangeId;
  readonly head: RefName;
  /** The commit the head branch points at — for a merged change, what merged. */
  readonly tip: CommitHash;
  /** The branch the change merges into. */
  readonly parent: RefName;
  readonly title: string;
  /** Who opened the change, mapped to a Cabaret identity by the `Forge` implementation. */
  readonly author: UserName;
  readonly state: "open" | "closed" | "merged";
  /** The users the forge holds as reviewers, mapped to Cabaret identities by the `Forge` implementation. */
  readonly reviewers: readonly UserName[];
  /** The commit that merged the change, when `state` is "merged". */
  readonly merge?: ForgeMerge | undefined;
}

/** A change-level discussion comment on a forge. */
export interface ForgeComment {
  readonly id: string;
  /** The author, mapped to a Cabaret identity by the `Forge` implementation. */
  readonly author: UserName;
  readonly body: string;
  /** When the comment was last edited in place; its creation time until then. */
  readonly updatedAt: TimestampMs;
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

  /** The value of git config `key`, or undefined when unset. */
  config(key: string): Promise<string | undefined>;

  /** Resolve `revision` (a ref name, hash prefix, `HEAD~1`, …) to a full commit hash. */
  resolveCommit(revision: string): Promise<CommitHash>;

  /** The commit branch `branch` points at, or undefined if it does not exist. */
  branchTip(branch: RefName): Promise<CommitHash | undefined>;

  /**
   * The commit `origin`'s copy of `branch` pointed at when last fetched, or
   * undefined when none is known. Pinned to `origin` like every other remote
   * operation, whatever upstream the branch is configured with. A local
   * reading, so it may trail the remote itself.
   */
  originTip(branch: RefName): Promise<CommitHash | undefined>;

  /** Create branch `name` at `commit`, failing if the branch already exists. */
  createBranch(name: RefName, commit: CommitHash): Promise<void>;

  /**
   * Rename change `from` to `to`: move its branch and its log to the new name
   * in one all-or-nothing transaction, retargeting HEAD when `from` is checked
   * out. Fails if `to`'s branch or log already exists, or if either of
   * `from`'s refs moves concurrently.
   */
  renameChange(from: RefName, to: RefName): Promise<void>;

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
   * As `merge`, but the new commit's sole parent is `onto`: `tip`'s tree
   * lands as one commit that does not carry `tip`'s history.
   */
  squash(into: RefName, onto: CommitHash, tip: CommitHash, message: string): Promise<CommitHash>;

  /**
   * The commits carrying the `LAND_TRAILER` trailer on the first-parent chain
   * from `base` to `tip`, oldest first — land merges, whose `onto` is their
   * first parent, and squash lands, whose `onto` is their sole parent.
   */
  landMerges(base: CommitHash, tip: CommitHash): Promise<readonly LandMerge[]>;

  /**
   * Push branch `branch` to the `origin` remote, replacing the remote branch
   * (changes rebase freely) but refusing to overwrite work this repository
   * has never fetched, as `git push --force-with-lease`.
   */
  pushBranch(branch: RefName): Promise<void>;

  /**
   * Fetch branch `branch` from the `origin` remote into the local branch of
   * the same name, creating it if absent. Fast-forward only: a local branch
   * that has diverged from the remote fails rather than being overwritten.
   */
  fetchBranch(branch: RefName): Promise<void>;

  /**
   * As `fetchBranch` for each of `branches`, in one round trip where the
   * backend can batch refspecs. Callers pass only branches absent locally.
   */
  fetchBranches(branches: readonly RefName[]): Promise<void>;

  /**
   * Sync `change`'s log with the `origin` remote: fetch the remote log, merge
   * it with the local log as `mergeLogs` does, and push the result. Either
   * side may be missing; syncing is how a change's review state reaches other
   * machines.
   */
  syncLog(change: RefName): Promise<void>;

  /**
   * Sync every log with the `origin` remote — every change with a log here,
   * there, or both — and return their names, sorted.
   */
  syncLogs(): Promise<readonly RefName[]>;

  /**
   * Delete the review state this repository holds: every change's log and the
   * fetched copies of origin's logs. Branches and commits are untouched, and
   * origin keeps its logs, so syncing restores them. Returns the names of the
   * changes whose logs were deleted, sorted.
   */
  wipeReviewState(): Promise<readonly RefName[]>;

  /**
   * Delete every change's log on the `origin` remote — for every user of the
   * repository, with no way to recover them. Returns the names of the changes
   * whose logs were deleted, sorted.
   */
  wipeOriginLogs(): Promise<readonly RefName[]>;

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
   * The name of every change, sorted by name: one per log ref. Only
   * `appendLog` creates logs and every log starts nonempty, so each named
   * change exists — though a landed change's branch may be gone.
   */
  listChanges(): Promise<readonly RefName[]>;

  /**
   * The entries of `change`'s log, oldest first. A change whose log ref does
   * not exist yet has the empty log, so no initialization step is needed.
   *
   * TODO: parent/child queries (the todo forest, the reparent and show-child
   * pickers) derive the parent relation by reading every change's log through
   * here, one git call each. If that lags once repos hold hundreds of
   * changes, add a batched or cached parent index to the backend rather than
   * memoizing in each caller.
   */
  readLog(change: RefName): Promise<readonly LogEntry[]>;

  /** Atomically append `entries` to `change`'s log, creating the log if needed. */
  appendLog(change: RefName, entries: readonly LogEntry[]): Promise<void>;

  /**
   * Delete `change`'s log everywhere this backend reaches: locally, the
   * fetched copy of origin's, and origin's own. Gone for every user — callers
   * decide a log holds nothing worth keeping before deleting it.
   */
  deleteLog(change: RefName): Promise<void>;
}

/**
 * The `kind`-actioned entry greatest by `compareLogEntries`, if any: the
 * timestamp, not log position, decides which entry is current.
 */
function latestAction<K extends LogAction["kind"]>(
  entries: readonly LogEntry[],
  kind: K,
): Extract<LogAction, { kind: K }> | undefined {
  let found: LogEntry | undefined;
  for (const entry of entries) {
    if (entry.action.kind === kind && (found === undefined || compareLogEntries(entry, found) >= 0)) {
      found = entry;
    }
  }
  return found?.action as Extract<LogAction, { kind: K }> | undefined;
}

/** Fail unless `change` has been created: a change exists exactly when its log is nonempty. */
export function assertChangeExists(change: RefName, entries: readonly LogEntry[]): void {
  if (entries.length === 0) {
    throw new UserError(
      `change does not exist: ${JSON.stringify(change)}; run \`cabaret create\`, or \`cabaret pull\` to import open forge changes`,
    );
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

/** The forge change from the log's latest `set-forge`, or undefined if none is recorded. */
export function currentForgeChange(
  entries: readonly LogEntry[],
): { readonly forge: ForgeLocator; readonly id: ForgeChangeId } | undefined {
  const action = latestAction(entries, "set-forge");
  // Rebuilt so the value is what the type says, with no `kind` tagging along.
  return action && { forge: action.forge, id: action.id };
}

/**
 * The parent the log last observed on `forge` — the latest `set-parent`
 * carrying it as `source` — or undefined when the forge's parent was never
 * observed. What a pull compares the forge's parent against: only a forge
 * that moved since last observed mirrors in, so a local reparent awaiting a
 * push is never overridden by re-observing the state it is about to replace.
 */
export function observedForgeParent(entries: readonly LogEntry[], forge: ForgeLocator): RefName | undefined {
  let found: LogEntry | undefined;
  for (const entry of entries) {
    if (
      entry.action.kind === "set-parent" &&
      entry.source?.forge === forge &&
      (found === undefined || compareLogEntries(entry, found) >= 0)
    ) {
      found = entry;
    }
  }
  return found?.action.kind === "set-parent" ? found.action.parent : undefined;
}

/**
 * The reviewer memberships a run of add/remove entries settles on: for each
 * user, the entry greatest by `compareLogEntries` among those `accept`ed
 * decides whether they are a reviewer.
 */
function foldReviewers(entries: readonly LogEntry[], accept: (entry: LogEntry) => boolean): Set<UserName> {
  const latest = new Map<UserName, { entry: LogEntry; member: boolean }>();
  for (const entry of entries) {
    const { action } = entry;
    if ((action.kind !== "add-reviewer" && action.kind !== "remove-reviewer") || !accept(entry)) {
      continue;
    }
    const prev = latest.get(action.reviewer);
    if (prev !== undefined && compareLogEntries(prev.entry, entry) > 0) {
      continue;
    }
    latest.set(action.reviewer, { entry, member: action.kind === "add-reviewer" });
  }
  const members = new Set<UserName>();
  for (const [user, { member }] of latest) {
    if (member) {
      members.add(user);
    }
  }
  return members;
}

/**
 * The change's reviewers: the users whose latest add/remove entry adds them,
 * sorted by name. Each reviewer implicitly owes review of the change's whole
 * diff, exactly as the owner does.
 */
export function currentReviewers(entries: readonly LogEntry[]): readonly UserName[] {
  return [...foldReviewers(entries, () => true)].sort();
}

/**
 * The reviewer set the log last observed on `forge`: for each user, the
 * latest add/remove entry carrying it as `source` decides. What a sync
 * compares the forge's reviewers against: only a forge that moved since last
 * observed mirrors in, so local edits awaiting a push are never overridden by
 * re-observing the state they are about to replace.
 */
export function observedForgeReviewers(entries: readonly LogEntry[], forge: ForgeLocator): ReadonlySet<UserName> {
  return foldReviewers(entries, (entry) => entry.source?.forge === forge);
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
    throw new UserError(`change has landed: ${JSON.stringify(change)} (merge ${merge})`);
  }
}

/** The endpoints of a diff a reviewer has reviewed. */
export interface ReviewedDiff {
  readonly base: CommitHash;
  readonly tip: CommitHash;
}

/**
 * What `user` knows of each file in a change — their brain: the diff they
 * most recently reviewed, per file. For each file the entry greatest by
 * `compareLogEntries` wins, and a winning `forget` erases the file's
 * knowledge.
 */
export function brain(entries: readonly LogEntry[], user: UserName): ReadonlyMap<FilePath, ReviewedDiff> {
  const latest = new Map<FilePath, { entry: LogEntry; reviewed?: ReviewedDiff }>();
  for (const entry of entries) {
    const { action } = entry;
    if (entry.user !== user || (action.kind !== "review" && action.kind !== "forget")) {
      continue;
    }
    const prev = latest.get(action.file);
    if (prev !== undefined && compareLogEntries(prev.entry, entry) > 0) {
      continue;
    }
    latest.set(
      action.file,
      action.kind === "review" ? { entry, reviewed: { base: action.base, tip: action.tip } } : { entry },
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
  const stored = currentBase(change, entries);
  // With no parent branch there is no merge-base; the stored base is the only
  // candidate, still valid while it remains an ancestor of the tip.
  if ((await backend.branchTip(parent)) === undefined) {
    if (await backend.isAncestor(stored, await backend.resolveCommit(`refs/heads/${change}`))) {
      return stored;
    }
    throw new UserError(
      `parent branch of ${JSON.stringify(change)} does not exist: ${JSON.stringify(parent)}; run \`cabaret reparent\``,
    );
  }
  const derived = await backend.mergeBase(parent, change);
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
  throw new UserError(
    `base of ${JSON.stringify(change)} is ambiguous: stored base ${stored} and ` +
      `merge-base ${derived} with parent ${JSON.stringify(parent)} are unrelated; rebase to resolve`,
  );
}

/**
 * The tip of `change`: the revision its diff is computed up to. A landed
 * change is frozen at the tip it landed as — a merge carries it as its second
 * parent, and a squash, whose commit descends from no reviewed history,
 * records it in the land entry instead; the branch may since be gone or moved
 * on. An unlanded change's tip is its branch, pinned to the branch namespace
 * so a same-named tag cannot shadow it.
 */
export async function changeTip(backend: Backend, change: RefName, entries: readonly LogEntry[]): Promise<CommitHash> {
  const landed = latestAction(entries, "land");
  if (landed === undefined) {
    return backend.resolveCommit(`refs/heads/${change}`);
  }
  return landed.tip ?? backend.resolveCommit(`${landed.merge}^2`);
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

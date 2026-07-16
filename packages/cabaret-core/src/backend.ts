import type { Branded } from "cabaret-util";
import { z } from "zod";
import { UserError } from "./error.js";
import type { Recommendation } from "./setup.js";

/**
 * A revision identifier in some backend's native format. Each backend brands
 * its own refinement — `CommitHash` for git — and its `parseRevision` is the
 * only way to obtain one, so a revision can never cross from one backend into
 * another. Core code handles revisions opaquely: it compares them, stores
 * them in logs, and passes them back to the backend they came from.
 */
export type Revision = Branded<string, "Revision">;

/** A full (non-abbreviated) git commit hash: the git backend's `Revision`, also what forges record. Obtain via `parseCommitHash`. */
export type CommitHash = Branded<Revision, "CommitHash">;

const COMMIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function parseCommitHash(raw: string): CommitHash {
  if (!COMMIT_HASH.test(raw)) {
    throw new Error(`not a commit hash: ${JSON.stringify(raw)}`);
  }
  return raw as CommitHash;
}

/** A branch or change name (e.g. "main"). Obtain via `parseRefName`. */
export type RefName = Branded<string, "RefName">;

// Cabaret's name grammar is the forbidden-character subset of `git
// check-ref-format`, the strictest backend: control chars and space, the
// glob/revision metacharacters, `..`, `@{`, a bare `@`, a component starting
// with `.`, a component ending in `.lock`, leading/trailing/doubled slashes,
// and a trailing `.` on the whole name. Names within it are valid in every
// backend, so a change never needs renaming to cross backends.
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

/** A user identity, as the backend attributes work (an email address). Obtain via `userName`. */
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

/**
 * Who is asked to review a change right now, from narrowest to widest. The
 * set is symbolic — "reviewers" tracks the reviewer list as it changes — and
 * gates only what todos ask of people; obligations must be satisfied to land
 * whoever is currently reviewing. "none" means the change is not ready for
 * review (a forge shows it as a draft), and review normally widens one step
 * at a time: the owner reads their own diff, then the reviewers, then anyone
 * with an obligation.
 */
export const REVIEWING = ["none", "owner", "reviewers", "everyone"] as const;
export type Reviewing = (typeof REVIEWING)[number];

/** The next wider reviewing set, or undefined when everyone already is. */
export function widerReviewing(reviewing: Reviewing): Reviewing | undefined {
  return REVIEWING[REVIEWING.indexOf(reviewing) + 1];
}

/** An action that can be recorded in a change's log. Revisions it records are in the owning backend's format. */
export type LogAction<R extends Revision = Revision> =
  | { readonly kind: "set-parent"; readonly parent: RefName }
  | { readonly kind: "set-base"; readonly base: R }
  | { readonly kind: "set-owner"; readonly owner: UserName }
  | { readonly kind: "set-forge"; readonly forge: ForgeLocator; readonly id: ForgeChangeId }
  | { readonly kind: "set-reviewing"; readonly reviewing: Reviewing }
  | { readonly kind: "add-reviewer"; readonly reviewer: UserName }
  | { readonly kind: "remove-reviewer"; readonly reviewer: UserName }
  | { readonly kind: "review"; readonly file: FilePath; readonly base: R; readonly tip: R }
  | { readonly kind: "forget"; readonly file: FilePath }
  | { readonly kind: "land"; readonly merge: R; readonly tip?: R | undefined }
  /** `edits` names the `commentHash` of the entry this comment supersedes: versions of one comment group through it, and the greatest timestamp is displayed. */
  | { readonly kind: "comment"; readonly text: string; readonly edits?: string | undefined };

/** One action recorded in a change's log. */
export interface LogEntry<R extends Revision = Revision> {
  /** When the entry was created. */
  readonly timestamp: TimestampMs;
  /** Who wrote the entry. */
  readonly user: UserName;
  /** The forge state the entry mirrors, for one that did not originate locally. */
  readonly source?: ForgeSource | undefined;
  /** The action taken. */
  readonly action: LogAction<R>;
}

const ForgeSourceSchema = z.object({
  forge: z.string().transform(parseForgeLocator),
  id: z.string().min(1).optional(),
}) satisfies z.ZodType<ForgeSource>;

/**
 * The log's wire format: entries are stored as this schema's JSON, one object
 * per line, keys in shape order. Revisions are opaque to the format, so the
 * schema is built around the owning backend's `parseRevision`; `satisfies`
 * has the compiler verify that the schema parses to exactly `LogEntry`.
 */
function logEntrySchema<R extends Revision>(parseRevision: (raw: string) => R): z.ZodType<LogEntry<R>> {
  const revision = z.string().transform(parseRevision);
  const action = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("set-parent"), parent: z.string().transform(parseRefName) }),
    z.object({ kind: z.literal("set-base"), base: revision }),
    z.object({ kind: z.literal("set-owner"), owner: z.string().min(1).transform(userName) }),
    z.object({
      kind: z.literal("set-forge"),
      forge: z.string().transform(parseForgeLocator),
      id: z.number().transform(forgeChangeId),
    }),
    z.object({ kind: z.literal("set-reviewing"), reviewing: z.enum(REVIEWING) }),
    z.object({ kind: z.literal("add-reviewer"), reviewer: z.string().min(1).transform(userName) }),
    z.object({ kind: z.literal("remove-reviewer"), reviewer: z.string().min(1).transform(userName) }),
    z.object({
      kind: z.literal("review"),
      file: z.string().transform(parseFilePath),
      base: revision,
      tip: revision,
    }),
    z.object({ kind: z.literal("forget"), file: z.string().transform(parseFilePath) }),
    z.object({ kind: z.literal("land"), merge: revision, tip: revision.optional() }),
    z.object({ kind: z.literal("comment"), text: z.string().min(1), edits: z.string().min(1).optional() }),
  ]) satisfies z.ZodType<LogAction<R>>;
  return z.object({
    timestamp: z.number().transform(timestampMs),
    user: z.string().min(1).transform(userName),
    source: ForgeSourceSchema.optional(),
    action,
  }) satisfies z.ZodType<LogEntry<R>>;
}

// Serialization does not re-parse revisions — the `R` brand certifies a
// backend already did — so one shape-checking schema serves every backend.
const WireLogEntrySchema = logEntrySchema((raw) => {
  if (raw === "") {
    throw new Error("revision must be nonempty");
  }
  return raw as Revision;
});

/**
 * Render an entry as its log line. Re-parsing through the schema validates
 * the entry and canonicalizes key order; `JSON.stringify` escapes any
 * newlines, so the result is always a single line.
 */
export function formatLogEntry<R extends Revision>(entry: LogEntry<R>): string {
  return `${JSON.stringify(WireLogEntrySchema.parse(entry))}\n`;
}

/** Parse one log line (without its trailing newline), inverting `formatLogEntry`. */
export function parseLogEntry<R extends Revision>(line: string, parseRevision: (raw: string) => R): LogEntry<R> {
  return parseLogLine(line, logEntrySchema(parseRevision));
}

function parseLogLine<R extends Revision>(line: string, schema: z.ZodType<LogEntry<R>>): LogEntry<R> {
  try {
    return schema.parse(JSON.parse(line));
  } catch (cause) {
    throw new Error(`malformed log line: ${JSON.stringify(line)}`, { cause });
  }
}

/** Parse a whole log: a sequence of newline-terminated `formatLogEntry` lines. */
export function parseLog<R extends Revision>(text: string, parseRevision: (raw: string) => R): readonly LogEntry<R>[] {
  if (text === "") {
    return [];
  }
  if (!text.endsWith("\n")) {
    throw new Error("malformed log: missing trailing newline");
  }
  const schema = logEntrySchema(parseRevision);
  return text
    .slice(0, -1)
    .split("\n")
    .map((line) => parseLogLine(line, schema));
}

/**
 * Total order on log entries: by timestamp, then by serialized line. Merged
 * logs hold concurrent entries from many machines, so every read that picks a
 * "latest" entry must break timestamp ties on content, never on log position,
 * for all machines to agree; only byte-identical entries compare equal.
 */
export function compareLogEntries<R extends Revision>(a: LogEntry<R>, b: LogEntry<R>): number {
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
export function mergeLogs<R extends Revision>(
  a: readonly LogEntry<R>[],
  b: readonly LogEntry<R>[],
): readonly LogEntry<R>[] {
  const byLine = new Map<string, LogEntry<R>>();
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
export interface LandMerge<R extends Revision = Revision> {
  readonly commit: R;
  readonly onto: R;
}

/** The commit that landed a change on its parent branch, however it was written. */
export interface LandedMerge<R extends Revision = Revision> {
  readonly commit: R;
  /** 2 for a true merge, whose second parent is the reviewed head; 1 for a squash or rebase, whose commit descends from no reviewed history. */
  readonly parents: number;
}

/** The commit that landed a merged forge change on its parent branch. */
export type ForgeMerge = LandedMerge<CommitHash>;

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
  /** Whether the forge shows the change as a draft: not ready for review, `reviewing: none`'s counterpart. */
  readonly draft: boolean;
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

/** Where a config write lands: this repository, or the person's global config. */
export type ConfigScope = "local" | "global";

/** One workspace of the repository: a working tree and what it has checked out. */
export interface Workspace {
  /** Absolute path of the workspace's root directory. */
  readonly path: string;
  /** The branch checked out there, or undefined when none is (git: detached HEAD; hg: no active bookmark). */
  readonly branch: RefName | undefined;
  /** Whether the working tree or index differs from the checkout, untracked files included. */
  readonly dirty: boolean;
  /** Whether this is the repository's primary working tree, which cannot be removed. */
  readonly primary: boolean;
}

/** The version-control systems a backend can speak for. */
export type Vcs = "git" | "hg";

/**
 * The operations Cabaret needs from a version-control backend, generic over
 * `R`, the backend's revision format. The implementations (`cabaret-node`)
 * shell out to a local git or hg.
 *
 * Vocabulary maps onto whatever the backend natively has: a "branch" is a git
 * branch or an hg bookmark, and "origin" is the pinned remote every remote
 * operation uses — git's `origin` remote, hg's `default` path.
 */
export interface Backend<R extends Revision = Revision> {
  /** Which version-control system this backend speaks. */
  readonly vcs: Vcs;

  /** Absolute path of the working tree the backend was opened in. */
  readonly root: string;

  /**
   * Parse a raw string as one of this backend's revisions, failing when it is
   * not in the backend's format. Declared as a property so `Backend<R>` is
   * assignable to `Backend<Revision>` but never to a differently-branded
   * backend, methods being bivariant.
   */
  readonly parseRevision: (raw: string) => R;

  /** The name of the branch checked out in the working tree. */
  currentBranch(): Promise<RefName>;

  /** The identity attributed to log entries this user writes. */
  currentUser(): Promise<UserName>;

  /**
   * The repo-relative path for a user-typed one, taken relative to the
   * directory the backend was opened from, so it names the same file diffs
   * and logs do. Fails when the path escapes the repository.
   */
  resolveFile(raw: string): FilePath;

  /** The value of config `key`, or undefined when unset. */
  config(key: string): Promise<string | undefined>;

  /**
   * Every value of multi-valued config `key`, in definition order; empty
   * when unset. Reads only `scope` when given, all scopes merged otherwise.
   */
  configAll(key: string, scope?: ConfigScope): Promise<readonly string[]>;

  /** Set single-valued config `key` to `value` in `scope`. */
  configSet(key: string, value: string, scope: ConfigScope): Promise<void>;

  /** Append `value` to multi-valued config `key` in `scope`. */
  configAdd(key: string, value: string, scope: ConfigScope): Promise<void>;

  /**
   * Remove `key`'s values in `scope` — those equal to `value`, or all of
   * them. Returns whether anything was removed.
   */
  configUnset(key: string, scope: ConfigScope, value?: string): Promise<boolean>;

  /** The configuration this backend recommends applying, audited and offered by setup. */
  setupRecommendations(): readonly Recommendation[];

  /** Resolve `expression`, in the backend's native revision syntax, to a full revision. */
  resolveCommit(expression: string): Promise<R>;

  /**
   * The commit branch `branch` points at, or undefined if it does not exist.
   * Resolved within the branch namespace itself, so nothing of another kind
   * (a same-named git tag, say) can shadow it.
   */
  branchTip(branch: RefName): Promise<R | undefined>;

  /**
   * The commit `origin`'s copy of `branch` pointed at when last fetched, or
   * undefined when none is known. Pinned to `origin` like every other remote
   * operation, whatever upstream the branch is configured with. A local
   * reading, so it may trail the remote itself.
   */
  originTip(branch: RefName): Promise<R | undefined>;

  /** Create branch `name` at `commit`, failing if the branch already exists. */
  createBranch(name: RefName, commit: R): Promise<void>;

  /**
   * Every workspace of the repository, the primary working tree first. A
   * workspace whose directory is gone is not a working tree anymore and is
   * dropped.
   */
  workspaces(): Promise<readonly Workspace[]>;

  /**
   * Create a workspace at `path` with `branch` checked out. Fails when
   * `path` already exists or the branch is checked out in another workspace
   * — a branch is checked out in at most one.
   */
  addWorkspace(path: string, branch: RefName): Promise<void>;

  /** Remove the workspace at `path`; `force` discards its uncommitted changes. */
  removeWorkspace(path: string, force: boolean): Promise<void>;

  /**
   * Check out `branch` in this workspace, carrying local edits along — and
   * failing when an edit would be overwritten.
   */
  checkout(branch: RefName): Promise<void>;

  /**
   * Rename change `from` to `to`: move its branch and its log to the new name
   * in one all-or-nothing transaction, retargeting HEAD when `from` is checked
   * out. Fails if `to`'s branch or log already exists, or if either of
   * `from`'s refs moves concurrently.
   */
  renameChange(from: RefName, to: RefName): Promise<void>;

  /** The last revision shared by the histories of `a` and `b`, failing when they share none. */
  mergeBase(a: R, b: R): Promise<R>;

  /** Whether `ancestor` is reachable from `descendant`'s history (a revision is its own ancestor). */
  isAncestor(ancestor: R, descendant: R): Promise<boolean>;

  /**
   * The tip a merge commit carries as its second parent — for a land merge,
   * the reviewed head it merged in. Fails when `merge` has fewer than two
   * parents.
   */
  mergedTip(merge: R): Promise<R>;

  /**
   * Merge `onto` into branch `change`: a content merge of the change's tip
   * and `onto` committed with parents tip then `onto`, carrying `message` —
   * or a plain fast-forward when the tip has nothing of its own. The merge
   * resolves against `base`, the change's own base, not the git merge-base:
   * what the change did since its base applies onto `onto`, so a parent
   * whose history was rewritten merges as cleanly as one that advanced.
   * Carries a checked-out `change`'s working tree along. Conflicts still
   * commit, markers left in the files, and come back as the conflicted
   * paths.
   */
  mergeOnto(change: RefName, base: R, onto: R, message: string): Promise<readonly FilePath[]>;

  /**
   * The paths that would conflict merging `tip` and `onto`, resolving
   * against `base` as `mergeOnto` does, without writing anything. Empty
   * means the merge is clean.
   */
  mergeConflicts(base: R, tip: R, onto: R): Promise<readonly FilePath[]>;

  /**
   * Create the merge commit recording `tip` merging into branch `into`:
   * parents `onto` then `tip`, carrying `message`. The tree is `tip`'s when
   * `onto` is `base` itself, and otherwise the content merge of `tip` and
   * `onto` resolved against `base` — which must be clean (`mergeConflicts`
   * empty), a conflict here being an error. Advances `into` from `onto` to
   * the new commit, failing if `into` no longer points at `onto`, and
   * carries a checked-out `into`'s working tree along.
   */
  merge(into: RefName, base: R, onto: R, tip: R, message: string): Promise<R>;

  /**
   * As `merge`, but the new commit's sole parent is `onto`: the tree lands
   * as one commit that does not carry `tip`'s history.
   */
  squash(into: RefName, base: R, onto: R, tip: R, message: string): Promise<R>;

  /**
   * The commits carrying the `LAND_TRAILER` trailer on the first-parent chain
   * from `base` to `tip`, oldest first — land merges, whose `onto` is their
   * first parent, and squash lands, whose `onto` is their sole parent.
   */
  landMerges(base: R, tip: R): Promise<readonly LandMerge<R>[]>;

  /**
   * Push branch `branch` to the `origin` remote, replacing the remote branch
   * (changes rebase freely) but refusing to overwrite work this repository
   * has never fetched.
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
  readFile(commit: R, file: FilePath): Promise<string | undefined>;

  /**
   * The file paths that differ between `base` and `tip`. A moved file counts
   * as a delete plus an add, so each path names the same file on both sides;
   * nested repositories (git submodules) are not files and are never listed.
   */
  changedFiles(base: R, tip: R): Promise<readonly FilePath[]>;

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
   * here, one subprocess call each. If that lags once repos hold hundreds of
   * changes, add a batched or cached parent index to the backend rather than
   * memoizing in each caller.
   */
  readLog(change: RefName): Promise<readonly LogEntry<R>[]>;

  /** Atomically append `entries` to `change`'s log, creating the log if needed. */
  appendLog(change: RefName, entries: readonly LogEntry<R>[]): Promise<void>;

  /**
   * Delete `change`'s log everywhere this backend reaches: locally, the
   * fetched copy of origin's, and origin's own. Gone for every user — callers
   * decide a log holds nothing worth keeping before deleting it.
   */
  deleteLog(change: RefName): Promise<void>;
}

/** The tip of `branch` via `branchTip`, failing when the branch does not exist. */
export async function requireBranchTip<R extends Revision>(backend: Backend<R>, branch: RefName): Promise<R> {
  const tip = await backend.branchTip(branch);
  if (tip === undefined) {
    throw new UserError(`branch does not exist: ${JSON.stringify(branch)}`);
  }
  return tip;
}

/**
 * The `kind`-actioned entry greatest by `compareLogEntries`, if any: the
 * timestamp, not log position, decides which entry is current.
 */
function latestAction<R extends Revision, K extends LogAction["kind"]>(
  entries: readonly LogEntry<R>[],
  kind: K,
): Extract<LogAction<R>, { kind: K }> | undefined {
  let found: LogEntry<R> | undefined;
  for (const entry of entries) {
    if (entry.action.kind === kind && (found === undefined || compareLogEntries(entry, found) >= 0)) {
      found = entry;
    }
  }
  return found?.action as Extract<LogAction<R>, { kind: K }> | undefined;
}

/** Fail unless `change` has been created: a change exists exactly when its log is nonempty. */
export function assertChangeExists(change: RefName, entries: readonly LogEntry<Revision>[]): void {
  if (entries.length === 0) {
    throw new UserError(
      `change does not exist: ${JSON.stringify(change)}; run \`cabaret create\`, or \`cabaret pull\` to import open forge changes`,
    );
  }
}

/** The parent from the log's latest `set-parent`; `create` starts every log with one, so a missing parent is an error. */
export function currentParent(change: RefName, entries: readonly LogEntry<Revision>[]): RefName {
  assertChangeExists(change, entries);
  const action = latestAction(entries, "set-parent");
  if (action === undefined) {
    throw new Error(`change has no parent: ${JSON.stringify(change)}`);
  }
  return action.parent;
}

/** The base from the log's latest `set-base`; `create` starts every log with one, so a missing base is an error. */
export function currentBase<R extends Revision>(change: RefName, entries: readonly LogEntry<R>[]): R {
  assertChangeExists(change, entries);
  const action = latestAction(entries, "set-base");
  if (action === undefined) {
    throw new Error(`change has no base: ${JSON.stringify(change)}`);
  }
  return action.base;
}

/** The owner from the log's latest `set-owner`; `create` starts every log with one, so a missing owner is an error. */
export function currentOwner(change: RefName, entries: readonly LogEntry<Revision>[]): UserName {
  assertChangeExists(change, entries);
  const action = latestAction(entries, "set-owner");
  if (action === undefined) {
    throw new Error(`change has no owner: ${JSON.stringify(change)}`);
  }
  return action.owner;
}

/** The forge change from the log's latest `set-forge`, or undefined if none is recorded. */
export function currentForgeChange(
  entries: readonly LogEntry<Revision>[],
): { readonly forge: ForgeLocator; readonly id: ForgeChangeId } | undefined {
  const action = latestAction(entries, "set-forge");
  // Rebuilt so the value is what the type says, with no `kind` tagging along.
  return action && { forge: action.forge, id: action.id };
}

/**
 * The reviewing set from the log's latest `set-reviewing`. A log that never
 * set one reads as "everyone": nobody ever restricted who is asked, so
 * obligations alone decide — which is also why importing a forge change that
 * is ready for review needs no entry.
 */
export function currentReviewing(entries: readonly LogEntry<Revision>[]): Reviewing {
  return latestAction(entries, "set-reviewing")?.reviewing ?? "everyone";
}

/**
 * The reviewing set the log last observed on `forge` — the latest
 * `set-reviewing` carrying it as `source` — or undefined when never observed.
 * A forge expresses only the none/wider boundary (draft or ready), so syncing
 * compares boundaries: only a forge that crossed it since last observed
 * mirrors in, and a local `set-reviewing` awaiting a push is never overridden
 * by re-observing the state it is about to replace.
 */
export function observedForgeReviewing(
  entries: readonly LogEntry<Revision>[],
  forge: ForgeLocator,
): Reviewing | undefined {
  let found: LogEntry | undefined;
  for (const entry of entries) {
    if (
      entry.action.kind === "set-reviewing" &&
      entry.source?.forge === forge &&
      (found === undefined || compareLogEntries(entry, found) >= 0)
    ) {
      found = entry;
    }
  }
  return found?.action.kind === "set-reviewing" ? found.action.reviewing : undefined;
}

/**
 * The parent the log last observed on `forge` — the latest `set-parent`
 * carrying it as `source` — or undefined when the forge's parent was never
 * observed. What a pull compares the forge's parent against: only a forge
 * that moved since last observed mirrors in, so a local reparent awaiting a
 * push is never overridden by re-observing the state it is about to replace.
 */
export function observedForgeParent(entries: readonly LogEntry<Revision>[], forge: ForgeLocator): RefName | undefined {
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
function foldReviewers(
  entries: readonly LogEntry<Revision>[],
  accept: (entry: LogEntry<Revision>) => boolean,
): Set<UserName> {
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
export function currentReviewers(entries: readonly LogEntry<Revision>[]): readonly UserName[] {
  return [...foldReviewers(entries, () => true)].sort();
}

/**
 * The reviewer set the log last observed on `forge`: for each user, the
 * latest add/remove entry carrying it as `source` decides. What a sync
 * compares the forge's reviewers against: only a forge that moved since last
 * observed mirrors in, so local edits awaiting a push are never overridden by
 * re-observing the state they are about to replace.
 */
export function observedForgeReviewers(
  entries: readonly LogEntry<Revision>[],
  forge: ForgeLocator,
): ReadonlySet<UserName> {
  return foldReviewers(entries, (entry) => entry.source?.forge === forge);
}

/** The merge that landed the change, or undefined if it has not landed. */
export function landedMerge<R extends Revision>(entries: readonly LogEntry<R>[]): R | undefined {
  return latestAction(entries, "land")?.merge;
}

/**
 * Fail if `change` has landed. Landing is final: the change's code is frozen
 * in its parent, so entries that would alter what there is to review may no
 * longer be written. Review state is not code, so `review` and `forget` stay
 * allowed and do not call this.
 */
export function assertNotLanded(change: RefName, entries: readonly LogEntry<Revision>[]): void {
  const merge = landedMerge(entries);
  if (merge !== undefined) {
    throw new UserError(`change has landed: ${JSON.stringify(change)} (merge ${merge})`);
  }
}

/** The endpoints of a diff a reviewer has reviewed. */
export interface ReviewedDiff<R extends Revision = Revision> {
  readonly base: R;
  readonly tip: R;
}

/**
 * What `user` knows of each file in a change — their brain: the diff they
 * most recently reviewed, per file. For each file the entry greatest by
 * `compareLogEntries` wins, and a winning `forget` erases the file's
 * knowledge.
 */
export function brain<R extends Revision>(
  entries: readonly LogEntry<R>[],
  user: UserName,
): ReadonlyMap<FilePath, ReviewedDiff<R>> {
  const latest = new Map<FilePath, { entry: LogEntry<R>; reviewed?: ReviewedDiff<R> }>();
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
  const known = new Map<FilePath, ReviewedDiff<R>>();
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
 * ancestor of the change's tip. Several candidates satisfy that invariant,
 * each covering the others' blind spots, so we take whichever reaches
 * furthest into the change's history:
 *
 * - The stored base (the log's latest `set-base`) goes stale when the change
 *   is rewritten outside Cabaret: its commits leave the change's history, so
 *   it stops being an ancestor of the tip and is discarded.
 * - The merge-base with a reading of the parent — its local branch, and
 *   origin's last-fetched copy — goes stale when that reading trails what
 *   the change was built on: it slides back to where the histories diverge,
 *   absorbing into the diff whatever landed in between. A reading that is
 *   too new is harmless, since a merge-base cannot reach past the change's
 *   own history, so the freshest reading wins by being deepest, and the
 *   change's own ancestry arbitrates between diverged readings.
 *
 * A candidate set with no deepest member means the change merged unrelated
 * lines; no winner is principled, so the user declares one by rebasing.
 */
export async function changeBase<R extends Revision>(
  backend: Backend<R>,
  change: RefName,
  entries: readonly LogEntry<R>[],
): Promise<R> {
  // Once the change lands, its parent's history contains the change itself,
  // so the merge-base slides to the change's own tip and would erase its
  // diff. `land` pins the base, and a landed change is frozen, so the stored
  // base stays correct forever.
  if (landedMerge(entries) !== undefined) {
    return currentBase(change, entries);
  }
  const parent = currentParent(change, entries);
  const stored = currentBase(change, entries);
  const tip = await requireBranchTip(backend, change);
  const readings = [...new Set([await backend.branchTip(parent), await backend.originTip(parent)])].filter(
    (reading): reading is R => reading !== undefined,
  );
  // With no reading of the parent there is no merge-base; the stored base is
  // the only candidate, still valid while it remains an ancestor of the tip.
  if (readings.length === 0) {
    if (await backend.isAncestor(stored, tip)) {
      return stored;
    }
    throw new UserError(
      `parent branch of ${JSON.stringify(change)} does not exist: ${JSON.stringify(parent)}; run \`cabaret reparent\``,
    );
  }
  const candidates = new Set<R>(await Promise.all(readings.map((reading) => backend.mergeBase(reading, tip))));
  if (!candidates.has(stored) && (await backend.isAncestor(stored, tip))) {
    candidates.add(stored);
  }
  let base: R | undefined;
  for (const candidate of candidates) {
    if (base === undefined || (await backend.isAncestor(base, candidate))) {
      base = candidate;
    }
  }
  if (base === undefined) {
    throw new Error(`no base candidates for ${JSON.stringify(change)}`);
  }
  for (const candidate of candidates) {
    if (!(await backend.isAncestor(candidate, base))) {
      throw new UserError(
        `base of ${JSON.stringify(change)} is ambiguous: candidates ` +
          `${[...candidates].join(", ")} are on unrelated lines; rebase to resolve`,
      );
    }
  }
  return base;
}

/**
 * The tip of `change`: the revision its diff is computed up to. A landed
 * change is frozen at the tip it landed as — a merge carries it as its second
 * parent, and a squash, whose commit descends from no reviewed history,
 * records it in the land entry instead; the branch may since be gone or moved
 * on. An unlanded change's tip is its branch, pinned to the branch namespace
 * so a same-named tag cannot shadow it.
 */
export async function changeTip<R extends Revision>(
  backend: Backend<R>,
  change: RefName,
  entries: readonly LogEntry<R>[],
): Promise<R> {
  const landed = latestAction(entries, "land");
  if (landed === undefined) {
    return requireBranchTip(backend, change);
  }
  return landed.tip ?? backend.mergedTip(landed.merge);
}

/**
 * The lines of `content` that open a conflict marker, each with its 1-based
 * number. Conflicts are a fact of the code, not of any record kept beside
 * it: a change is conflicted exactly while marker lines survive in its
 * files, and fixing them — however that happens — is what resolves it.
 */
export function conflictMarkers(content: string): readonly { readonly line: number; readonly text: string }[] {
  const hits: { line: number; text: string }[] = [];
  content.split("\n").forEach((text, index) => {
    if (text.startsWith("<<<<<<<")) {
      hits.push({ line: index + 1, text });
    }
  });
  return hits;
}

/** The files among `files` whose contents at `commit` carry conflict markers, in `files` order. */
export async function conflictedFiles<R extends Revision>(
  backend: Backend<R>,
  commit: R,
  files: readonly FilePath[],
): Promise<readonly FilePath[]> {
  const marked = await Promise.all(
    files.map(async (file) => {
      const content = await backend.readFile(commit, file);
      return content !== undefined && conflictMarkers(content).length > 0;
    }),
  );
  return files.filter((_, index) => marked[index]);
}

/** One contiguous span of a change's history that a reviewer must review. */
export interface ReviewSpan<R extends Revision = Revision> {
  readonly start: R;
  readonly end: R;
}

/**
 * The spans of `base`..`tip` left for a reviewer to review, oldest first.
 *
 * Land merges on the first-parent chain split the history into spans: the
 * diff each merge brings in was already reviewed in the landed child, so what
 * needs review is base → first land's onto, then each land merge → the next
 * land's onto, and finally the last land merge → tip. A span a land merge
 * jumps over entirely (its start is its end) is dropped.
 */
export async function reviewSpans<R extends Revision>(
  backend: Backend<R>,
  base: R,
  tip: R,
): Promise<readonly ReviewSpan<R>[]> {
  const spans: ReviewSpan<R>[] = [];
  let start = base;
  for (const { commit, onto } of await backend.landMerges(base, tip)) {
    if (start !== onto) {
      spans.push({ start, end: onto });
    }
    start = commit;
  }
  if (start !== tip) {
    spans.push({ start, end: tip });
  }
  return spans;
}

/**
 * The spans of `spans` past `reviewedTip`, the tip of a reviewer's brain for
 * a review whose base matches the spans' (a moved base invalidates span
 * endpoints, so callers handle that case separately): spans the reviewer has
 * already reviewed past are dropped, and the span containing `reviewedTip`
 * resumes from it.
 */
export async function remainingSpans<R extends Revision>(
  backend: Backend<R>,
  spans: readonly ReviewSpan<R>[],
  reviewedTip: R,
): Promise<readonly ReviewSpan<R>[]> {
  const remaining: ReviewSpan<R>[] = [];
  for (const span of spans) {
    if (await backend.isAncestor(span.end, reviewedTip)) {
      continue;
    }
    const inside =
      (await backend.isAncestor(span.start, reviewedTip)) && (await backend.isAncestor(reviewedTip, span.end));
    remaining.push(inside ? { start: reviewedTip, end: span.end } : span);
  }
  return remaining;
}

/** A review span and the files its diff changes. */
export interface SpanDiff<R extends Revision = Revision> extends ReviewSpan<R> {
  readonly changed: ReadonlySet<FilePath>;
}

/**
 * A change's diff, read once: its endpoints and review spans, each with the
 * files its diff changes. Everything derived from the diff — summaries,
 * review rounds, obligations — takes one of these, so a page that computes
 * several shares one reading instead of each re-querying the history.
 */
export interface ChangeDiff<R extends Revision = Revision> {
  readonly base: R;
  readonly tip: R;
  readonly spans: readonly SpanDiff<R>[];
}

export async function changeDiff<R extends Revision>(
  backend: Backend<R>,
  change: RefName,
  entries: readonly LogEntry<R>[],
): Promise<ChangeDiff<R>> {
  const [base, tip] = await Promise.all([changeBase(backend, change, entries), changeTip(backend, change, entries)]);
  return diffBetween(backend, base, tip);
}

/** The diff of `base`..`tip`, for callers that resolved the endpoints themselves. */
export async function diffBetween<R extends Revision>(backend: Backend<R>, base: R, tip: R): Promise<ChangeDiff<R>> {
  const spans = await Promise.all(
    (await reviewSpans(backend, base, tip)).map(async (span) => ({
      ...span,
      changed: new Set(await backend.changedFiles(span.start, span.end)),
    })),
  );
  return { base, tip, spans };
}

/** The files of `diff` whose contents at its tip still carry conflict markers, sorted by name. */
export async function changeConflicts<R extends Revision>(
  backend: Backend<R>,
  diff: ChangeDiff<R>,
): Promise<readonly FilePath[]> {
  return conflictedFiles(backend, diff.tip, [...new Set(diff.spans.flatMap(({ changed }) => [...changed]))].sort());
}

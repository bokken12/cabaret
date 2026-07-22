import type { Branded } from "cabaret-util";
import { z } from "zod";
import { UserError } from "./error.js";
import type { Recommendation } from "./setup.js";

/**
 * A revision identifier in some backend's native format, obtained only
 * through a backend's `parseRevision`, which enforces its grammar. Core code
 * handles revisions opaquely: it compares them, stores them in logs, and
 * passes them back to the backend they came from.
 */
export type Revision = Branded<string, "Revision">;

const COMMIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Parse a full (non-abbreviated) git commit hash: the git backend's `parseRevision`, also what forges record. */
export function parseCommitHash(raw: string): Revision {
  if (!COMMIT_HASH.test(raw)) {
    throw new Error(`not a commit hash: ${JSON.stringify(raw)}`);
  }
  return raw as Revision;
}

/**
 * The name of a change (or of a parent it builds on, trunk included),
 * obtained only through a backend's `parseName`, which enforces its native
 * grammar. Backends map the name onto whatever they natively point at code
 * with: a git branch.
 */
export type ChangeName = Branded<string, "ChangeName">;

// The forbidden-character subset of `git check-ref-format`: control chars and
// space, the glob/revision metacharacters, `..`, `@{`, a bare `@`, a
// component starting with `.`, a component ending in `.lock`,
// leading/trailing/doubled slashes, and a trailing `.` on the whole name.
// biome-ignore lint/suspicious/noControlCharactersInRegex: git ref names forbid control characters, so we must match them.
const BRANCH_NAME_FORBIDDEN = /[\x00-\x20~^:?*[\\\x7f]|\.\.|@\{|^@$|(?:^|\/)\.|\/\/|\.lock(?:$|\/)|^\/|\/$|\.$/;

/** Parse a git branch name: the git backend's `parseName`, also what forges target. */
export function parseBranchName(raw: string): ChangeName {
  if (raw === "" || BRANCH_NAME_FORBIDDEN.test(raw)) {
    throw new UserError(`not a valid branch name: ${JSON.stringify(raw)}`);
  }
  return raw as ChangeName;
}

/**
 * A change's permanent identity: random, minted at create, immutable. Log
 * refs are keyed by it, so renaming a change never moves a ref; names are
 * log state (`set-name`) resolved through `naming.ts`.
 */
export type ChangeId = Branded<string, "ChangeId">;

const CHANGE_ID = /^[0-9a-f]{32}$/;

export function parseChangeId(raw: string): ChangeId {
  if (!CHANGE_ID.test(raw)) {
    throw new UserError(`not a change id: ${JSON.stringify(raw)}`);
  }
  return raw as ChangeId;
}

// WebCrypto exists in every supported runtime but is absent from the bare
// es2025 lib this platform-agnostic package compiles against.
declare const crypto: { getRandomValues(array: Uint8Array): Uint8Array };

/** Mint a fresh `ChangeId`: 16 random bytes as lowercase hex. */
export function mintChangeId(): ChangeId {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("") as ChangeId;
}

/** A repository-relative file path, as named in diffs. Obtain via `parseFilePath`. */
export type FilePath = Branded<string, "FilePath">;

export function parseFilePath(raw: string): FilePath {
  if (raw === "" || raw.includes("\0")) {
    throw new UserError(`not a valid file path: ${JSON.stringify(raw)}`);
  }
  return raw as FilePath;
}

/** The base-side file a changed file was moved or copied from. */
export interface FileSource {
  readonly path: FilePath;
  /** A copy's source survives at the tip; a move's does not. */
  readonly copied: boolean;
}

/** A file a diff changes, named by its path at the diff's tip side. */
export interface ChangedFile {
  /** The file's path at the tip — or at the base for a file the diff deletes. */
  readonly path: FilePath;
  /** The source the diff moved or copied the file from, when it records one. */
  readonly source: FileSource | undefined;
}

/** `path` alone, or `old -> path` naming a move's source — `=>` a copy's. */
export function fileLabel(path: FilePath, source: FileSource | undefined): string {
  return source === undefined ? path : `${source.path} ${source.copied ? "=>" : "->"} ${path}`;
}

/** A unix timestamp in milliseconds. Obtain via `timestampMs`. */
export type TimestampMs = Branded<number, "TimestampMs">;

export function timestampMs(raw: number): TimestampMs {
  if (!Number.isSafeInteger(raw) || raw < 0) {
    throw new Error(`not a millisecond timestamp: ${raw}`);
  }
  return raw as TimestampMs;
}

/** A user identity: an email as the backend attributes work, or a forge account like `github:alice`. Obtain via `userName`. */
export type UserName = Branded<string, "UserName">;

/** Tag `raw` as a user name. Applies no validation. */
export function userName(raw: string): UserName {
  return raw as UserName;
}

/** The schemes forge accounts are written under, one per supported forge. */
export const forgeAccountSchemes = ["github", "gitlab", "codeberg"] as const;

export type ForgeAccountScheme = (typeof forgeAccountSchemes)[number];

/** The identity for a forge account: its name under the forge's scheme, e.g. `github:alice`. */
export function forgeAccount(scheme: ForgeAccountScheme, account: string): UserName {
  return userName(`${scheme}:${account}`);
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

/** The route each supported forge serves a change's page under, keyed by the locator's host. */
const FORGE_CHANGE_ROUTES: Record<string, string> = {
  "github.com": "pull",
  "gitlab.com": "-/merge_requests",
  "codeberg.org": "pulls",
};

/** The web page for change `id` on `forge`, or undefined for an unrecognized host. */
export function forgeChangeUrl(forge: ForgeLocator, id: ForgeChangeId): string | undefined {
  const route = FORGE_CHANGE_ROUTES[forge.split("/")[0] as string];
  return route === undefined ? undefined : `https://${forge}/${route}/${id}`;
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

/** An action that can be recorded in a change's log. Revisions and names it records are in the owning backend's formats. */
export type LogAction =
  | { readonly kind: "set-name"; readonly name: ChangeName }
  | { readonly kind: "set-parent"; readonly parent: ChangeName }
  | { readonly kind: "set-base"; readonly base: Revision }
  | { readonly kind: "set-owner"; readonly owner: UserName }
  | { readonly kind: "set-forge"; readonly forge: ForgeLocator; readonly id: ForgeChangeId }
  | { readonly kind: "set-reviewing"; readonly reviewing: Reviewing }
  | { readonly kind: "set-archived"; readonly archived: boolean }
  | { readonly kind: "set-permanent"; readonly permanent: boolean }
  | { readonly kind: "add-reviewer"; readonly reviewer: UserName }
  | { readonly kind: "remove-reviewer"; readonly reviewer: UserName }
  | { readonly kind: "review"; readonly file: FilePath; readonly base: Revision; readonly tip: Revision }
  | { readonly kind: "forget"; readonly file: FilePath }
  | { readonly kind: "land"; readonly merge: Revision; readonly tip?: Revision | undefined }
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

/**
 * The log's wire format: entries are stored as this schema's JSON, one object
 * per line, keys in shape order. Revisions and names are opaque to the
 * format, so the schema is built around the owning backend's `parseRevision`
 * and `parseName`; `satisfies` has the compiler verify that the schema parses
 * to exactly `LogEntry`.
 */
function logEntrySchema(
  parseRevision: (raw: string) => Revision,
  parseName: (raw: string) => ChangeName,
): z.ZodType<LogEntry> {
  const revision = z.string().transform(parseRevision);
  const action = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("set-name"), name: z.string().transform(parseName) }),
    z.object({ kind: z.literal("set-parent"), parent: z.string().transform(parseName) }),
    z.object({ kind: z.literal("set-base"), base: revision }),
    z.object({ kind: z.literal("set-owner"), owner: z.string().min(1).transform(userName) }),
    z.object({
      kind: z.literal("set-forge"),
      forge: z.string().transform(parseForgeLocator),
      id: z.number().transform(forgeChangeId),
    }),
    z.object({ kind: z.literal("set-reviewing"), reviewing: z.enum(REVIEWING) }),
    z.object({ kind: z.literal("set-archived"), archived: z.boolean() }),
    z.object({ kind: z.literal("set-permanent"), permanent: z.boolean() }),
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
  ]) satisfies z.ZodType<LogAction>;
  return z.object({
    timestamp: z.number().transform(timestampMs),
    user: z.string().min(1).transform(userName),
    source: ForgeSourceSchema.optional(),
    action,
  }) satisfies z.ZodType<LogEntry>;
}

// Serialization does not re-parse revisions or names — the brands certify a
// backend already did — so one shape-checking schema serves every backend.
function nonempty<T>(what: string): (raw: string) => T {
  return (raw) => {
    if (raw === "") {
      throw new Error(`${what} must be nonempty`);
    }
    return raw as T;
  };
}

const WireLogEntrySchema = logEntrySchema(nonempty<Revision>("revision"), nonempty<ChangeName>("name"));

/**
 * Render an entry as its log line. Re-parsing through the schema validates
 * the entry and canonicalizes key order; `JSON.stringify` escapes any
 * newlines, so the result is always a single line.
 */
export function formatLogEntry(entry: LogEntry): string {
  return `${JSON.stringify(WireLogEntrySchema.parse(entry))}\n`;
}

/** Parse one log line (without its trailing newline), inverting `formatLogEntry`. */
export function parseLogEntry(
  line: string,
  parseRevision: (raw: string) => Revision,
  parseName: (raw: string) => ChangeName,
): LogEntry {
  return parseLogLine(line, logEntrySchema(parseRevision, parseName));
}

function parseLogLine(line: string, schema: z.ZodType<LogEntry>): LogEntry {
  try {
    return schema.parse(JSON.parse(line));
  } catch (cause) {
    throw new Error(`malformed log line: ${JSON.stringify(line)}`, { cause });
  }
}

/** Parse a whole log: a sequence of newline-terminated `formatLogEntry` lines. */
export function parseLog(
  text: string,
  parseRevision: (raw: string) => Revision,
  parseName: (raw: string) => ChangeName,
): readonly LogEntry[] {
  if (text === "") {
    return [];
  }
  if (!text.endsWith("\n")) {
    throw new Error("malformed log: missing trailing newline");
  }
  const schema = logEntrySchema(parseRevision, parseName);
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
export function landTitle(change: ChangeName): string {
  return `Land ${change}`;
}

/** The trailer line marking the commit that lands `change`. */
export function landTrailer(change: ChangeName): string {
  return `${LAND_TRAILER}: ${change}`;
}

/** The message for the commit that lands `change`. */
export function landMessage(change: ChangeName): string {
  return `${landTitle(change)}\n\n${landTrailer(change)}\n`;
}

/** A commit that landed a change, and the parent tip it landed onto. */
export interface LandMerge {
  /** The landed change, as the commit's trailer names it. */
  readonly change: ChangeName;
  readonly commit: Revision;
  readonly onto: Revision;
}

/** A merge on a change's first-parent chain, or a squash land standing among them. */
export interface ChainMerge {
  readonly commit: Revision;
  /** The first parent: what the chain held before the merge. A squash land's sole parent. */
  readonly onto: Revision;
  /** The second parent: what the merge brought in. Undefined for a squash land. */
  readonly merged: Revision | undefined;
  /** The change the commit's land trailer names, when it carries one. */
  readonly landed: ChangeName | undefined;
}

/** The land merges among `merges`, in the same order. */
export function landsAmong(merges: readonly ChainMerge[]): readonly LandMerge[] {
  return merges.flatMap(({ commit, onto, landed }) => (landed === undefined ? [] : [{ change: landed, commit, onto }]));
}

/** The commit that landed a change on its parent branch, however it was written. */
export interface LandedMerge {
  readonly commit: Revision;
  /** 2 for a true merge, whose second parent is the reviewed head; 1 for a squash or rebase, whose commit descends from no reviewed history. */
  readonly parents: number;
}

/** The commit that landed a merged forge change on its parent branch. */
export type ForgeMerge = LandedMerge;

/** A change as a forge holds it: a pull request (GitHub) or merge request (GitLab). */
export interface ForgeChange {
  readonly id: ForgeChangeId;
  readonly head: ChangeName;
  /** The commit the head branch points at — for a merged change, what merged. */
  readonly tip: Revision;
  /** The branch the change merges into. */
  readonly parent: ChangeName;
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
  /** The branch checked out there, or undefined when none is (a detached HEAD). */
  readonly change: ChangeName | undefined;
  /** Whether the working tree or index differs from the checkout, untracked files included. */
  readonly dirty: boolean;
  /** Whether this is the repository's primary working tree, which cannot be removed. */
  readonly primary: boolean;
}

/**
 * The operations Cabaret needs from a version-control backend. The
 * implementation (`cabaret-node`) shells out to a local git. "origin" is the
 * one pinned remote every remote operation uses.
 */
export interface Backend {
  /** Absolute path of the working tree the backend was opened in. */
  readonly root: string;

  /**
   * Parse a raw string as one of this backend's revisions, failing when it is
   * not in the backend's format.
   */
  readonly parseRevision: (raw: string) => Revision;

  /**
   * Parse a raw string as one of this backend's change names, failing when
   * the backend's name grammar rejects it.
   */
  readonly parseName: (raw: string) => ChangeName;

  /** The name of the branch checked out in the working tree. */
  currentChange(): Promise<ChangeName>;

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
  resolveCommit(expression: string): Promise<Revision>;

  /**
   * The commit branch `branch` points at, or undefined if it does not exist.
   * Resolved within the branch namespace itself, so nothing of another kind
   * (a same-named git tag, say) can shadow it.
   */
  tip(change: ChangeName): Promise<Revision | undefined>;

  /**
   * The commit `origin`'s copy of `branch` pointed at when last fetched, or
   * undefined when none is known. Pinned to `origin` like every other remote
   * operation, whatever upstream the branch is configured with. A local
   * reading, so it may trail the remote itself.
   */
  originTip(change: ChangeName): Promise<Revision | undefined>;

  /**
   * When this workspace last fetched from origin successfully — cabaret's
   * fetch or anyone's — or undefined when none is known. A fetch that fails
   * loses the reading until the next success.
   */
  originFetched(): Promise<TimestampMs | undefined>;

  /** Create branch `name` at `commit`, failing if the branch already exists. */
  create(change: ChangeName, at: Revision): Promise<void>;

  /**
   * Fast-forward branch `change` to `to`, which must descend from its tip;
   * fails on a concurrent move rather than dropping work. Carries a
   * checked-out `change`'s working tree along.
   */
  advance(change: ChangeName, to: Revision): Promise<void>;

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
  addWorkspace(path: string, change: ChangeName): Promise<void>;

  /** Remove the workspace at `path`; `force` discards its uncommitted changes. */
  removeWorkspace(path: string, force: boolean): Promise<void>;

  /**
   * Check out `branch` in this workspace, carrying local edits along — and
   * failing when an edit would be overwritten.
   */
  checkout(change: ChangeName): Promise<void>;

  /**
   * Commit this workspace's edits — modified, added, and deleted files alike
   * — to the checked-out branch with `message`. `paths`, each a path or one
   * of the backend's native patterns, restrict what is committed; empty
   * commits everything. Fails when there is nothing to commit.
   */
  commit(message: string, paths: readonly FilePath[]): Promise<void>;

  /** Whether this clone holds `revision`'s objects. */
  hasRevision(revision: Revision): Promise<boolean>;

  /** The last revision shared by the histories of `a` and `b`, failing when they share none. */
  mergeBase(a: Revision, b: Revision): Promise<Revision>;

  /** Whether `ancestor` is reachable from `descendant`'s history (a revision is its own ancestor). */
  isAncestor(ancestor: Revision, descendant: Revision): Promise<boolean>;

  /**
   * The tip a merge commit carries as its second parent — for a land merge,
   * the reviewed head it merged in. Fails when `merge` has fewer than two
   * parents.
   */
  mergedTip(merge: Revision): Promise<Revision>;

  /**
   * The history a commit was committed onto — its first parent. For a land,
   * merge or squash alike, the parent history the change landed onto.
   */
  mergedOnto(merge: Revision): Promise<Revision>;

  /**
   * Merge `onto` into branch `change`: a content merge of the change's tip
   * and `onto` committed with parents tip then `onto`, carrying `message` —
   * or a plain fast-forward when the tip has nothing of its own. The merge
   * resolves against `base`, the change's own base: what the change did
   * since its base applies onto `onto`. The base overrides the graph's
   * merge-base, so a parent whose history was rewritten merges as cleanly
   * as one that advanced. Carries a checked-out `change`'s working tree
   * along.
   * Conflicts still commit, markers left in the files, and come back as the
   * conflicted paths.
   */
  mergeOnto(change: ChangeName, base: Revision, onto: Revision, message: string): Promise<readonly FilePath[]>;

  /**
   * The paths that would conflict merging `tip` and `onto`, resolving
   * against `base` as `mergeOnto` does, without writing anything. Empty
   * means the merge is clean.
   */
  mergeConflicts(base: Revision, tip: Revision, onto: Revision): Promise<readonly FilePath[]>;

  /**
   * Create the merge commit recording `tip` merging into branch `into`:
   * parents `onto` then `tip`, carrying `message`. The tree is `tip`'s when
   * `onto` is `base` itself, and otherwise the content merge of `tip` and
   * `onto` resolved against `base` — which must be clean (`mergeConflicts`
   * empty), a conflict here being an error. Advances `into` from `onto` to
   * the new commit, failing if `into` no longer points at `onto`, and
   * carries a checked-out `into`'s working tree along.
   */
  merge(into: ChangeName, base: Revision, onto: Revision, tip: Revision, message: string): Promise<Revision>;

  /**
   * As `merge`, but the new commit's sole parent is `onto`: the tree lands
   * as one commit that does not carry `tip`'s history.
   */
  squash(into: ChangeName, base: Revision, onto: Revision, tip: Revision, message: string): Promise<Revision>;

  /**
   * The merges among the newest `scan` commits of `tip`'s first-parent
   * chain, oldest first — plus squash lands, single-parent commits carrying
   * the `LAND_TRAILER` trailer — with `root`, the first parent of the
   * oldest surveyed commit (undefined at a root commit or an empty survey),
   * and whether the chain continues past the survey. `base` stops the walk
   * where the chain enters its ancestry; undefined surveys a long-lived
   * branch, whose history only `scan` bounds.
   */
  chainMerges(
    base: Revision | undefined,
    tip: Revision,
    scan: number,
  ): Promise<{ readonly merges: readonly ChainMerge[]; readonly root: Revision | undefined; readonly more: boolean }>;

  /**
   * Push branch `branch` to the `origin` remote, replacing the remote branch
   * (changes rebase freely) but refusing to overwrite work this repository
   * has never fetched.
   */
  push(change: ChangeName): Promise<void>;

  /**
   * Fetch branch `branch` from the `origin` remote into the local branch of
   * the same name, creating it if absent. Fast-forward only: a local branch
   * that has diverged from the remote fails rather than being overwritten.
   */
  fetch(change: ChangeName): Promise<void>;

  /**
   * Refresh origin's last-fetched copies wholesale — branches (what
   * `originTip` reads) and change logs alike. Moves no local branch.
   */
  fetchOrigin(): Promise<void>;

  /**
   * Fast-forward local branches onto origin's last-fetched copies where the
   * move loses nothing: only to a descendant of the branch's tip, and a
   * branch checked out in a workspace advances only when that workspace is
   * clean — its working tree follows the branch — so no line of work anyone
   * holds open moves. Returns the branches advanced, sorted. Reads
   * last-fetched copies only; `fetchOrigin` first to advance onto fresh
   * ones.
   */
  advanceBranches(): Promise<readonly ChangeName[]>;

  /**
   * Sync `change`'s log with the `origin` remote: merge origin's last-fetched
   * log with the local one as `mergeLogs` does, and push the result. Either
   * side may be missing; syncing is how a change's review state reaches other
   * machines. Reads last-fetched logs; `fetchOrigin` first to absorb fresh
   * entries — a push landing on a ref origin moved re-fetches and converges,
   * so no appended entry is ever lost to staleness.
   */
  syncLog(change: ChangeId): Promise<void>;

  /**
   * Sync every log with the `origin` remote — every change with a log here or
   * fetched from there — and return their ids, sorted. Reads last-fetched
   * logs, as `syncLog` does.
   */
  syncLogs(): Promise<readonly ChangeId[]>;

  /**
   * Merge origin's reading into every branch of `changes` whose readings
   * have genuinely diverged, when the merge is conflict-free: an idle branch
   * joins in place, a clean workspace's tree follows, a dirty one holds its
   * branch put, and a join that would conflict is left for `sync`. Returns
   * what joined, sorted.
   */
  joinBranches(changes: readonly ChangeName[]): Promise<readonly ChangeName[]>;

  /** Origin's forge sweep record as last fetched, or undefined when none is known. */
  forgeSweepState(): Promise<string | undefined>;

  /**
   * Replace origin's forge sweep record, unless it moved since last
   * fetched — a racer's advance serves in this one's stead, so the record
   * never regresses and losing the race skips rather than retries.
   */
  publishForgeSweepState(content: string): Promise<void>;

  /**
   * Delete the review state this repository holds: every change's log and the
   * fetched copies of origin's logs. Branches and commits are untouched, and
   * origin keeps its logs, so syncing restores them. Returns how many
   * changes' logs were deleted, whatever ref layout they used.
   */
  wipeReviewState(): Promise<number>;

  /**
   * Delete every change's log on the `origin` remote — for every user of the
   * repository, with no way to recover them. Returns how many changes' logs
   * were deleted, whatever ref layout they used.
   */
  wipeOriginLogs(): Promise<number>;

  /** The contents of `file` at `commit`, or undefined if no file exists there. */
  readFile(commit: Revision, file: FilePath): Promise<string | undefined>;

  /**
   * The files that differ between `base` and `tip`, each named by its path
   * at `tip` — or at `base` for a file the diff deletes. A moved file is one
   * entry naming its source, whether or not its contents also changed, and a
   * file recognizably copied from another carries its source the same way;
   * nested repositories (git submodules) are not files and are never listed.
   */
  changedFiles(base: Revision, tip: Revision): Promise<readonly ChangedFile[]>;

  /**
   * The id of every change, sorted: one per log ref. Only `appendLog`
   * creates logs and every log starts nonempty, so each id names a change
   * that exists — though a landed change's branch may be gone.
   */
  listChanges(): Promise<readonly ChangeId[]>;

  /**
   * The entries of `change`'s log, oldest first. A change whose log ref does
   * not exist yet has the empty log, so no initialization step is needed.
   *
   * TODO: parent/child queries (the home forest, the reparent and show-child
   * pickers) derive the parent relation by reading every change's log through
   * here, one subprocess call each. If that lags once repos hold hundreds of
   * changes, add a batched or cached parent index to the backend rather than
   * memoizing in each caller.
   */
  readLog(change: ChangeId): Promise<readonly LogEntry[]>;

  /** Atomically append `entries` to `change`'s log, creating the log if needed. */
  appendLog(change: ChangeId, entries: readonly LogEntry[]): Promise<void>;

  /**
   * Delete `change`'s log everywhere this backend reaches: locally, the
   * fetched copy of origin's, and origin's own. Gone for every user — callers
   * decide a log holds nothing worth keeping before deleting it.
   */
  deleteLog(change: ChangeId): Promise<void>;
}

/**
 * The tip `change` reads as: its local branch, or origin's last-fetched copy
 * when no local branch exists. Reading never creates the branch — an adopted
 * change is reviewable straight from origin's copy, and only an operation
 * that moves the branch (`ensureBranch`) materializes it.
 */
export async function requireTip(backend: Backend, change: ChangeName): Promise<Revision> {
  const tip = (await backend.tip(change)) ?? (await backend.originTip(change));
  if (tip === undefined) {
    throw new UserError(`${JSON.stringify(change)} does not exist`);
  }
  return tip;
}

/**
 * The freshest reading of a branch: the descendant-most of its local tip and
 * origin's last-fetched copy. A local branch is a working position, not
 * evidence — facts like rebase targets and staleness read the freshest copy
 * this clone holds, wherever it lives. Diverged readings have no freshest
 * side: both come back for the caller to arbitrate.
 */
export async function freshestReading(
  backend: Backend,
  branch: ChangeName,
): Promise<
  | { readonly kind: "none" }
  | { readonly kind: "fresh"; readonly tip: Revision }
  | { readonly kind: "diverged"; readonly local: Revision; readonly origin: Revision }
> {
  const local = await backend.tip(branch);
  const origin = await backend.originTip(branch);
  if (local === undefined) {
    return origin === undefined ? { kind: "none" } : { kind: "fresh", tip: origin };
  }
  if (origin === undefined || origin === local || (await backend.isAncestor(origin, local))) {
    return { kind: "fresh", tip: local };
  }
  return (await backend.isAncestor(local, origin))
    ? { kind: "fresh", tip: origin }
    : { kind: "diverged", local, origin };
}

/**
 * The tip of `change`'s local branch, created at origin's copy when only
 * origin holds one. Operations that move the branch call this; creating the
 * branch at origin's tip loses nothing and asks no decision of the user, so
 * it happens without ceremony.
 */
export async function ensureBranch(backend: Backend, change: ChangeName): Promise<Revision> {
  const local = await backend.tip(change);
  if (local !== undefined) {
    return local;
  }
  const origin = await backend.originTip(change);
  if (origin === undefined) {
    throw new UserError(`${JSON.stringify(change)} does not exist`);
  }
  await backend.create(change, origin);
  return origin;
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
export function assertChangeExists(change: ChangeName, entries: readonly LogEntry[]): void {
  if (entries.length === 0) {
    throw new UserError(
      `change does not exist: ${JSON.stringify(change)}; run \`cab create\`, or \`cab fetch\` to import open forge changes`,
    );
  }
}

/** The name from the log's latest `set-name`, or undefined when the log never recorded one. */
export function currentName(entries: readonly LogEntry[]): ChangeName | undefined {
  return latestAction(entries, "set-name")?.name;
}

/** The parent from the log's latest `set-parent`; `create` starts every log with one, so a missing parent is an error. */
export function currentParent(change: ChangeName, entries: readonly LogEntry[]): ChangeName {
  assertChangeExists(change, entries);
  const action = latestAction(entries, "set-parent");
  if (action === undefined) {
    throw new Error(`change has no parent: ${JSON.stringify(change)}`);
  }
  return action.parent;
}

/** The base from the log's latest `set-base`; `create` starts every log with one, so a missing base is an error. */
export function currentBase(change: ChangeName, entries: readonly LogEntry[]): Revision {
  assertChangeExists(change, entries);
  const action = latestAction(entries, "set-base");
  if (action === undefined) {
    throw new Error(`change has no base: ${JSON.stringify(change)}`);
  }
  return action.base;
}

/** The owner from the log's latest `set-owner`; `create` starts every log with one, so a missing owner is an error. */
export function currentOwner(change: ChangeName, entries: readonly LogEntry[]): UserName {
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
 * The reviewing set from the log's latest `set-reviewing`. A log that never
 * set one reads as "everyone": nobody ever restricted who is asked, so
 * obligations alone decide — which is also why importing a forge change that
 * is ready for review needs no entry.
 */
export function currentReviewing(entries: readonly LogEntry[]): Reviewing {
  return latestAction(entries, "set-reviewing")?.reviewing ?? "everyone";
}

/**
 * Whether the change is archived — set aside as not landing — from the log's
 * latest `set-archived`. A log that never set one reads as live, so no entry
 * is needed to create a change unarchived.
 */
export function currentArchived(entries: readonly LogEntry[]): boolean {
  return latestAction(entries, "set-archived")?.archived ?? false;
}

/**
 * Whether the change is permanent — structure expected to outlive its lands,
 * like a long-lived umbrella others stack work under — from the log's latest
 * `set-permanent`. A log that never set one reads as ordinary: the change is
 * done when it lands.
 */
export function currentPermanent(entries: readonly LogEntry[]): boolean {
  return latestAction(entries, "set-permanent")?.permanent ?? false;
}

/**
 * The archived state the log last observed on `forge` — the latest
 * `set-archived` carrying it as `source` — or undefined when never observed.
 * A forge expresses archiving as its open/closed state, so syncing compares
 * against it: only a forge that closed or reopened since last observed
 * mirrors in, and a local `set-archived` awaiting a push is never overridden
 * by re-observing the state it is about to replace.
 */
export function observedForgeArchived(entries: readonly LogEntry[], forge: ForgeLocator): boolean | undefined {
  let found: LogEntry | undefined;
  for (const entry of entries) {
    if (
      entry.action.kind === "set-archived" &&
      entry.source?.forge === forge &&
      (found === undefined || compareLogEntries(entry, found) >= 0)
    ) {
      found = entry;
    }
  }
  return found?.action.kind === "set-archived" ? found.action.archived : undefined;
}

/**
 * The reviewing set the log last observed on `forge` — the latest
 * `set-reviewing` carrying it as `source` — or undefined when never observed.
 * A forge expresses only the none/wider boundary (draft or ready), so syncing
 * compares boundaries: only a forge that crossed it since last observed
 * mirrors in, and a local `set-reviewing` awaiting a push is never overridden
 * by re-observing the state it is about to replace.
 */
export function observedForgeReviewing(entries: readonly LogEntry[], forge: ForgeLocator): Reviewing | undefined {
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
export function observedForgeParent(entries: readonly LogEntry[], forge: ForgeLocator): ChangeName | undefined {
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

/** The merge of the change's latest land, or undefined if it has never landed. */
export function landedMerge(entries: readonly LogEntry[]): Revision | undefined {
  return latestAction(entries, "land")?.merge;
}

/**
 * Whether the change is finished: landed, and archived with the landing —
 * either atomically by an ordinary land, or by hand afterwards. A finished
 * change's diff readings freeze at the cycle that landed; a change that
 * landed but stays live — permanent structure, or one reopened by
 * unarchiving — reads on, its next rebase starting the next cycle.
 */
export function finished(entries: readonly LogEntry[]): boolean {
  return landedMerge(entries) !== undefined && currentArchived(entries);
}

/**
 * Fail if `change` is archived. Archiving sets a change aside as not
 * landing, so a land must be preceded by an explicit unarchive.
 */
export function assertNotArchived(change: ChangeName, entries: readonly LogEntry[]): void {
  if (currentArchived(entries)) {
    throw new UserError(`change is archived: ${JSON.stringify(change)}; run \`cab archive --undo\``);
  }
}

/** The endpoints of a diff a reviewer has reviewed. */
export interface ReviewedDiff {
  readonly base: Revision;
  readonly tip: Revision;
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
 * ancestor of the change's tip. Several candidates satisfy that invariant,
 * each covering the others' blind spots, so we take whichever reaches
 * furthest into the change's history:
 *
 * - The stored base (the log's latest `set-base`) is only ever a hint: it
 *   goes stale when the change is rewritten outside Cabaret — its commits
 *   leave the change's history, so it stops being an ancestor of the tip —
 *   and a log written elsewhere may record a revision on a branch never
 *   pushed anywhere this clone fetches from, so it competes only while this
 *   clone holds its objects and it remains an ancestor of the tip.
 * - The merge-base with a reading of the parent — its local branch, and
 *   origin's last-fetched copy — goes stale when that reading trails what
 *   the change was built on: it slides back to where the histories diverge,
 *   absorbing into the diff whatever landed in between. A reading that is
 *   too new is harmless, since a merge-base cannot reach past the change's
 *   own history, so the freshest reading wins by being deepest, and the
 *   change's own ancestry arbitrates between diverged readings.
 * - Once the change finishes — lands and archives — its parent's history
 *   contains the change itself, so a parent reading's merge-base would slide
 *   to the change's own tip and erase its diff. The land merge freezes the
 *   history the change landed onto as its first parent, so that becomes the
 *   one reading instead. A change that landed but stays live reads its
 *   parent as ever: its base advancing past the land is exactly how its next
 *   cycle begins.
 *
 * A candidate set with no deepest member means the change merged unrelated
 * lines; no winner is principled, so the user declares one by rebasing.
 */
export async function changeBase(
  backend: Backend,
  change: ChangeName,
  entries: readonly LogEntry[],
): Promise<Revision> {
  const stored = currentBase(change, entries);
  const tip = await changeTip(backend, change, entries);
  const landed = finished(entries) ? landedMerge(entries) : undefined;
  let readings: readonly Revision[];
  if (landed !== undefined) {
    readings = (await backend.hasRevision(landed)) ? [await backend.mergedOnto(landed)] : [];
  } else {
    const parent = currentParent(change, entries);
    readings = [...new Set([await backend.tip(parent), await backend.originTip(parent)])].filter(
      (reading): reading is Revision => reading !== undefined,
    );
  }
  const storedValid = (await backend.hasRevision(stored)) && (await backend.isAncestor(stored, tip));
  // With no reading there is no merge-base; the stored base is the only
  // candidate.
  if (readings.length === 0) {
    if (storedValid) {
      return stored;
    }
    throw landed !== undefined
      ? new UserError(`land merge of ${JSON.stringify(change)} is not in this clone: ${landed}; run \`cab fetch\``)
      : new UserError(
          `parent branch of ${JSON.stringify(change)} does not exist: ` +
            `${JSON.stringify(currentParent(change, entries))}; run \`cab reparent\``,
        );
  }
  const candidates = new Set<Revision>(await Promise.all(readings.map((reading) => backend.mergeBase(reading, tip))));
  if (storedValid) {
    candidates.add(stored);
  }
  let base: Revision | undefined;
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
          `${[...candidates].join(", ")} are on unrelated lines` +
          (landed === undefined ? "; rebase to resolve" : ""),
      );
    }
  }
  return base;
}

/**
 * The tip of `change`: the revision its diff is computed up to. A finished
 * change is frozen at the tip it landed as — a merge carries it as its second
 * parent, and a squash, whose commit descends from no reviewed history,
 * records it in the land entry instead; the branch may since be gone or moved
 * on. A live change's tip is its branch, pinned to the branch namespace
 * so a same-named tag cannot shadow it.
 */
export async function changeTip(backend: Backend, change: ChangeName, entries: readonly LogEntry[]): Promise<Revision> {
  const landed = finished(entries) ? latestAction(entries, "land") : undefined;
  if (landed === undefined) {
    return requireTip(backend, change);
  }
  if (landed.tip !== undefined) {
    // A squash does not carry the reviewed history, so a clone that never
    // fetched it while the branch lived cannot reach the recorded tip.
    if (!(await backend.hasRevision(landed.tip))) {
      throw new UserError(`landed tip of ${JSON.stringify(change)} is not in this clone: ${landed.tip}`);
    }
    return landed.tip;
  }
  if (!(await backend.hasRevision(landed.merge))) {
    throw new UserError(
      `land merge of ${JSON.stringify(change)} is not in this clone: ${landed.merge}; run \`cab fetch\``,
    );
  }
  return backend.mergedTip(landed.merge);
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
export async function conflictedFiles(
  backend: Backend,
  commit: Revision,
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

/** The files changed between `base` and `tip` whose contents at `tip` carry conflict markers. */
export async function conflictsBetween(backend: Backend, base: Revision, tip: Revision): Promise<readonly FilePath[]> {
  return conflictedFiles(
    backend,
    tip,
    (await backend.changedFiles(base, tip)).map(({ path }) => path),
  );
}

/**
 * A change's diff, read once: its endpoints, the files changed between them,
 * and the land merges on the way. Everything derived from the diff —
 * summaries, review left, obligations — takes one of these, so a page that
 * computes several shares one reading instead of each re-querying the
 * history.
 */
export interface ChangeDiff {
  readonly base: Revision;
  readonly tip: Revision;
  /** The land merges on the first-parent chain, oldest first. */
  readonly lands: readonly LandMerge[];
  /** The files the diff changes, keyed by their `ChangedFile` path. */
  readonly changed: ReadonlyMap<FilePath, ChangedFile>;
}

export async function changeDiff(
  backend: Backend,
  change: ChangeName,
  entries: readonly LogEntry[],
): Promise<ChangeDiff> {
  const [base, tip] = await Promise.all([changeBase(backend, change, entries), changeTip(backend, change, entries)]);
  return diffBetween(backend, base, tip);
}

/**
 * First-parent commits a land-merge walk surveys before giving up: far past
 * any workable change's history, and still cheap for git to scan.
 */
export const LAND_SCAN = 10_000;

/**
 * The complete first-parent chain survey of `base`..`tip`. Review reads
 * through every land on the chain — a shortened answer would silently drop
 * some — so a history outrunning `LAND_SCAN` commits, which no one could
 * review anyway, is an error instead.
 */
export async function completeChainMerges(
  backend: Backend,
  base: Revision,
  tip: Revision,
): Promise<{ readonly merges: readonly ChainMerge[]; readonly root: Revision | undefined }> {
  const { merges, root, more } = await backend.chainMerges(base, tip, LAND_SCAN);
  if (more) {
    throw new UserError(`history spans more than ${LAND_SCAN} commits; rebase onto a fresher parent`);
  }
  return { merges, root };
}

/** The diff of `base`..`tip`, for callers that resolved the endpoints themselves. */
export async function diffBetween(backend: Backend, base: Revision, tip: Revision): Promise<ChangeDiff> {
  const [{ merges }, changed] = await Promise.all([
    completeChainMerges(backend, base, tip),
    backend.changedFiles(base, tip),
  ]);
  return { base, tip, lands: landsAmong(merges), changed: changedByPath(changed) };
}

/** Key `files` by path, the identity every diff-derived structure shares. */
export function changedByPath(files: readonly ChangedFile[]): ReadonlyMap<FilePath, ChangedFile> {
  return new Map(files.map((file) => [file.path, file]));
}

/** The files of `diff` whose contents at its tip still carry conflict markers, sorted by name. */
export async function changeConflicts(backend: Backend, diff: ChangeDiff): Promise<readonly FilePath[]> {
  return conflictedFiles(backend, diff.tip, [...diff.changed.keys()].sort());
}

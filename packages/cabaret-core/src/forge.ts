import {
  type Backend,
  type CommitHash,
  compareLogEntries,
  type FilePath,
  type ForgeLocator,
  type ForgeRequestId,
  formatLogEntry,
  type LogEntry,
  landedMerge,
  type RefName,
  type TimestampMs,
  type UserName,
} from "./backend.js";

// WebCrypto and TextEncoder exist in every supported runtime (Node and
// browsers alike) but are absent from the bare es2025 lib this
// platform-agnostic package compiles against.
declare const crypto: {
  readonly subtle: { digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer> };
};
declare class TextEncoder {
  encode(input: string): Uint8Array;
}

/** A pull request (GitHub) or merge request (GitLab) on a forge. */
export interface ForgeRequest {
  readonly id: ForgeRequestId;
  readonly head: RefName;
  readonly base: RefName;
  readonly title: string;
  /** Who opened the request, mapped to a Cabaret identity by the `Forge` implementation. */
  readonly author: UserName;
  readonly state: "open" | "closed" | "merged";
  /** How many files the request touches. */
  readonly changedFiles: number;
  /** The commit that merged the request, when `state` is "merged". */
  readonly merge?: CommitHash;
}

/** A request-level discussion comment on a forge. */
export interface ForgeComment {
  readonly id: string;
  /** The author, mapped to a Cabaret identity by the `Forge` implementation. */
  readonly author: UserName;
  readonly body: string;
  /** When the comment was last edited in place; its creation time until then. */
  readonly updatedAt: TimestampMs;
}

/**
 * The operations Cabaret needs from a code forge (GitHub, GitLab, …).
 * Implementations live in `cabaret-github` and friends.
 */
export interface Forge {
  /** Identifies this forge and repository, e.g. "github.com/test-org/widgets". */
  readonly locator: ForgeLocator;

  /** The open request with head `branch`, or undefined if there is none. */
  findRequest(branch: RefName): Promise<ForgeRequest | undefined>;

  /** Every open request, in no particular order. */
  listOpenRequests(): Promise<readonly ForgeRequest[]>;

  getRequest(id: ForgeRequestId): Promise<ForgeRequest>;

  /** Open a request merging `head` into `base`. `head` must already be pushed. */
  createRequest(head: RefName, base: RefName, title: string): Promise<ForgeRequest>;

  /** Retarget an open request's base branch. */
  setBase(id: ForgeRequestId, base: RefName): Promise<void>;

  /** The paths of the files the request touches. */
  listFiles(id: ForgeRequestId): Promise<readonly FilePath[]>;

  /** The request-level comments, oldest first. */
  listComments(id: ForgeRequestId): Promise<readonly ForgeComment[]>;

  /** Post a request-level comment. */
  addComment(id: ForgeRequestId, body: string): Promise<void>;
}

/**
 * A comment entry's identity: the SHA-256 of its log line. Entries are
 * immutable, so the hash is permanent; both sync directions use it to
 * recognize a comment they have seen before.
 */
export async function commentHash(entry: LogEntry): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(formatLogEntry(entry)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// A pushed body ends with its entry's hash in an HTML comment: markdown
// swallows it when rendering, so it is invisible on the forge, but it
// survives in the raw body, which is how a comment Cabaret pushed is
// recognized from any machine. Exactly the two newlines the push added are
// stripped — no more, so a text ending in newlines round-trips — plus any
// trailing whitespace a forge-side edit may have introduced.
const MARKER = /\n\n<!-- cabaret:([0-9a-f]{64}) -->\s*$/;

/** A comment entry restricted to the `comment` action. */
type CommentEntry = LogEntry & { readonly action: { readonly kind: "comment" } };

function commentEntries(entries: readonly LogEntry[]): CommentEntry[] {
  return entries.filter((entry): entry is CommentEntry => entry.action.kind === "comment");
}

/** `entry`'s text with its author named, for a post the forge attributes to someone else's token. */
function attributedText(entry: CommentEntry): string {
  return `**${entry.user}:**\n\n${entry.action.text}`;
}

/** How `entry`'s text reads when posted by `self`: foreign authors are named, since the forge attributes the post to `self`'s token. */
function postedText(entry: CommentEntry, self: UserName): string {
  return entry.user === self ? entry.action.text : attributedText(entry);
}

/**
 * The entries importing what is new on the forge: comments Cabaret has not
 * seen, and new versions of comments since edited in place. Every field of an
 * imported entry is determined by the forge's data alone — never a local
 * clock or identity — so any two machines pulling the same state append
 * byte-identical lines, which union-merged logs deduplicate.
 */
export async function planPull(
  forge: ForgeLocator,
  entries: readonly LogEntry[],
  comments: readonly ForgeComment[],
): Promise<readonly LogEntry[]> {
  // Comments that originated here, by hash: what a marker can point back to.
  const local = new Map<string, CommentEntry>();
  // The latest imported version of each forge comment already in the log.
  const imported = new Map<string, CommentEntry>();
  for (const entry of commentEntries(entries)) {
    const source = entry.action.source;
    if (source === undefined) {
      local.set(await commentHash(entry), entry);
    } else if (source.forge === forge) {
      const prev = imported.get(source.id);
      if (prev === undefined || compareLogEntries(entry, prev) >= 0) {
        imported.set(source.id, entry);
      }
    }
  }
  const additions: LogEntry[] = [];
  for (const comment of comments) {
    const hash = MARKER.exec(comment.body)?.[1];
    const text = comment.body.replace(MARKER, "");
    if (text === "") {
      continue;
    }
    const latest = imported.get(comment.id);
    const origin = hash === undefined ? undefined : local.get(hash);
    if (latest !== undefined) {
      if (latest.action.text === text) {
        continue;
      }
    } else if (origin !== undefined && (text === origin.action.text || text === attributedText(origin))) {
      // Our own push reflected back: the body is the entry's text, plain when
      // its author pushed it themselves, attributed when someone else did.
      continue;
    }
    // A marker always names the entry the comment is a version of, even one
    // this log has never held (another user's Cabaret pushed it): once logs
    // sync, the versions still fall into one group.
    const edits = latest?.action.source?.edits ?? hash;
    additions.push({
      timestamp: comment.updatedAt,
      user: comment.author,
      action: {
        kind: "comment",
        text,
        source: { forge, id: comment.id, ...(edits === undefined ? {} : { edits }) },
      },
    });
  }
  return additions;
}

/**
 * The bodies to post for comments the forge has not seen: local-origin
 * entries whose hash no marker on the forge carries, oldest first. Listing
 * before posting is what makes a rerun — from this or any other machine — a
 * no-op.
 */
export async function planPush(
  entries: readonly LogEntry[],
  comments: readonly ForgeComment[],
  self: UserName,
): Promise<readonly string[]> {
  const posted = new Set<string>();
  for (const comment of comments) {
    const hash = MARKER.exec(comment.body)?.[1];
    if (hash !== undefined) {
      posted.add(hash);
    }
  }
  const pending: { readonly entry: CommentEntry; readonly body: string }[] = [];
  for (const entry of commentEntries(entries)) {
    if (entry.action.source !== undefined) {
      continue;
    }
    const hash = await commentHash(entry);
    if (posted.has(hash)) {
      continue;
    }
    pending.push({ entry, body: `${postedText(entry, self)}\n\n<!-- cabaret:${hash} -->` });
  }
  // Post oldest first, in an order independent of log position so every
  // machine posts the same sequence.
  pending.sort((a, b) => compareLogEntries(a.entry, b.entry));
  return pending.map(({ body }) => body);
}

/**
 * The land entry a merged `request` implies, or undefined when `entries`
 * already record one: however the merge is observed, it means the change
 * landed.
 */
export function observedLand(
  now: () => TimestampMs,
  user: UserName,
  request: ForgeRequest,
  entries: readonly LogEntry[],
): LogEntry | undefined {
  if (request.state !== "merged" || request.merge === undefined || landedMerge(entries) !== undefined) {
    return undefined;
  }
  return { timestamp: now(), user, action: { kind: "land", merge: request.merge } };
}

/** What importing a request produced: a new change, or the discovery that its log already exists. */
export type ImportResult =
  | { readonly kind: "imported"; readonly change: RefName; readonly comments: number }
  | { readonly kind: "exists"; readonly change: RefName };

/**
 * Import request `id` as a change to review: fetch its head branch, create
 * the change owned by the request's author with the request's base branch as
 * its parent, and pull the request's comments.
 */
export async function importRequest(
  backend: Backend,
  now: () => TimestampMs,
  forge: Forge,
  id: ForgeRequestId,
): Promise<ImportResult> {
  const request = await forge.getRequest(id);
  const change = request.head;
  // Sync first so a change already imported on another machine is adopted as
  // itself rather than re-created.
  await backend.syncLog(change);
  if ((await backend.readLog(change)).length > 0) {
    return { kind: "exists", change };
  }
  // Import creates the log; it never moves local branches. Only a missing
  // branch is fetched — one that exists stays as it is, not least because
  // git refuses to fetch into a branch some worktree has checked out.
  if ((await backend.branchTip(change)) === undefined) {
    await backend.fetchBranch(change);
  }
  const user = await backend.currentUser();
  const additions: LogEntry[] = [
    { timestamp: now(), user, action: { kind: "set-parent", parent: request.base } },
    { timestamp: now(), user, action: { kind: "set-base", base: await backend.mergeBase(request.base, change) } },
    { timestamp: now(), user, action: { kind: "set-owner", owner: request.author } },
    { timestamp: now(), user, action: { kind: "set-forge", forge: forge.locator, request: id } },
    ...(await planPull(forge.locator, [], await forge.listComments(id))),
  ];
  // Without the land entry, a merged request's merge-base slides to its own
  // tip and the diff to review vanishes.
  const landing = observedLand(now, user, request, []);
  if (landing !== undefined) {
    additions.push(landing);
  }
  await backend.appendLog(change, additions);
  return { kind: "imported", change, comments: additions.filter(({ action }) => action.kind === "comment").length };
}

/** One comment as displayed: the latest version of its group. */
export interface ChangeComment {
  readonly timestamp: TimestampMs;
  readonly user: UserName;
  readonly text: string;
}

/**
 * The comments of a change as displayed, oldest first. Versions of one
 * comment — imports sharing a source id, and a local entry with the
 * forge-side edits that supersede it — collapse to the version with the
 * greatest timestamp.
 */
export async function currentComments(entries: readonly LogEntry[]): Promise<readonly ChangeComment[]> {
  const groups = new Map<string, { first: TimestampMs; latest: CommentEntry }>();
  for (const entry of commentEntries(entries)) {
    const source = entry.action.source;
    const key = source === undefined ? await commentHash(entry) : (source.edits ?? `${source.forge}#${source.id}`);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { first: entry.timestamp, latest: entry });
      continue;
    }
    if (entry.timestamp < group.first) {
      group.first = entry.timestamp;
    }
    if (compareLogEntries(entry, group.latest) >= 0) {
      group.latest = entry;
    }
  }
  return [...groups.values()]
    .sort((a, b) => a.first - b.first)
    .map(({ latest }) => ({ timestamp: latest.timestamp, user: latest.user, text: latest.action.text }));
}

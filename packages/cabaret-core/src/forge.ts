import {
  type Backend,
  type CommitHash,
  compareLogEntries,
  currentForgeChange,
  currentParent,
  type ForgeChange,
  type ForgeChangeId,
  type ForgeComment,
  type ForgeLocator,
  type ForgeMerge,
  type ForgeSnapshot,
  formatLogEntry,
  type LogEntry,
  landedMerge,
  landTitle,
  landTrailer,
  type RefName,
  type SnapshotChange,
  type TimestampMs,
  type UserName,
} from "./backend.js";
import type { Config, LandMethod } from "./config.js";
import { UserError } from "./error.js";
import { type LandOverrides, landChange, prepareLand, recordLand } from "./ops.js";

// WebCrypto and TextEncoder exist in every supported runtime (Node and
// browsers alike) but are absent from the bare es2025 lib this
// platform-agnostic package compiles against.
declare const crypto: {
  readonly subtle: { digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer> };
};
declare class TextEncoder {
  encode(input: string): Uint8Array;
}

/**
 * The operations Cabaret needs from a code forge (GitHub, GitLab, …).
 * Implementations live in `cabaret-github` and friends.
 *
 * Rendering never calls a forge: it reads the backend's `ForgeSnapshot`,
 * which the commands that talk to the forge refresh via `syncForgeSnapshot`.
 */
export interface Forge {
  /** Identifies this forge and repository, e.g. "github.com/test-org/widgets". */
  readonly locator: ForgeLocator;

  /**
   * Every open change with the files and comments previewing it needs, in no
   * particular order. Taken in one sweep so a snapshot costs a handful of API
   * calls however many changes are open; in return each change's files and
   * comments may be capped (at the first hundred or so) — an import still
   * reads comments in full through `listComments`.
   */
  fetchSnapshot(): Promise<readonly SnapshotChange[]>;

  /** The open change with head `branch`, or undefined if there is none. */
  findChange(branch: RefName): Promise<ForgeChange | undefined>;

  getChange(id: ForgeChangeId): Promise<ForgeChange>;

  /** Open a change merging `head` into `parent`. `head` must already be pushed. */
  createChange(head: RefName, parent: RefName, title: string): Promise<ForgeChange>;

  /** Retarget an open change's parent branch. */
  setParent(id: ForgeChangeId, parent: RefName): Promise<void>;

  /**
   * Land an open change by merging it into its parent branch, the new commit's
   * message carrying `title` and `message` as its body; returns what landed.
   * `method` asks for a merge commit or a squash, but a forge whose settings
   * dictate the landing shape may write something else — the returned merge
   * reports the shape that actually landed. `tip` is what the caller validated
   * as the change's head: the forge merges only if the head still matches, so
   * a concurrent push cannot land unreviewed commits. Fails when the head
   * moved or the change cannot merge cleanly.
   */
  landChange(
    id: ForgeChangeId,
    method: LandMethod,
    tip: CommitHash,
    title: string,
    message: string,
  ): Promise<ForgeMerge>;

  /** The change-level comments, oldest first. */
  listComments(id: ForgeChangeId): Promise<readonly ForgeComment[]>;

  /** Post a change-level comment. */
  addComment(id: ForgeChangeId, body: string): Promise<void>;
}

/**
 * Mirror the forge's open changes into the backend's stored snapshot,
 * returning what was written.
 */
export async function syncForgeSnapshot(
  backend: Backend,
  now: () => TimestampMs,
  forge: Forge,
): Promise<ForgeSnapshot> {
  const snapshot: ForgeSnapshot = { locator: forge.locator, takenAt: now(), changes: await forge.fetchSnapshot() };
  await backend.writeForgeSnapshot(snapshot);
  return snapshot;
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
 * The land entry a merged `forgeChange` implies, or undefined when `entries`
 * already record one: however the merge is observed, it means the change
 * landed. A single-parent landing commit (a squash or rebase merge) descends
 * from no reviewed history, so the entry freezes the head that merged as the
 * change's tip.
 */
export function observedLand(
  now: () => TimestampMs,
  user: UserName,
  forgeChange: ForgeChange,
  entries: readonly LogEntry[],
): LogEntry | undefined {
  if (forgeChange.state !== "merged" || forgeChange.merge === undefined || landedMerge(entries) !== undefined) {
    return undefined;
  }
  const { commit, parents } = forgeChange.merge;
  return {
    timestamp: now(),
    user,
    action: { kind: "land", merge: commit, ...(parents > 1 ? {} : { tip: forgeChange.tip }) },
  };
}

/**
 * The forge change `change` syncs with: the log's `set-forge` when it names
 * one on this forge, else the change's branch's open forge change, adopted
 * with a `set-forge` entry. Undefined when the forge has none either.
 */
export async function syncedForgeChange(
  backend: Backend,
  now: () => TimestampMs,
  forge: Forge,
  change: RefName,
  entries: readonly LogEntry[],
): Promise<ForgeChange | undefined> {
  const recorded = currentForgeChange(entries);
  if (recorded !== undefined && recorded.forge === forge.locator) {
    return forge.getChange(recorded.id);
  }
  const found = await forge.findChange(change);
  if (found !== undefined) {
    await backend.appendLog(change, [
      {
        timestamp: now(),
        user: await backend.currentUser(),
        action: { kind: "set-forge", forge: forge.locator, id: found.id },
      },
    ]);
  }
  return found;
}

/**
 * Land `change` by merging it on the forge: after the same checks a local
 * land makes — freshening the local parent from origin first, since the
 * forge merges into origin's copy — land the forge change with `method`,
 * record the landing (as `recordLand`), and fetch the parent so this
 * repository sees the land. The commit's message carries the land trailer,
 * exactly as a local land's would, so the parent's reviewers skip the diff
 * it brings in.
 */
export async function landOnForge(
  backend: Backend,
  now: () => TimestampMs,
  forge: Forge,
  change: RefName,
  entries: readonly LogEntry[],
  forgeChange: ForgeChange,
  method: LandMethod,
  overrides: LandOverrides,
): Promise<CommitHash> {
  if (forgeChange.state === "merged") {
    throw new UserError(
      `${forge.locator}#${forgeChange.id} was already merged; run \`cabaret gh pull\` to record the land`,
    );
  }
  if (forgeChange.state === "closed") {
    throw new UserError(
      `${forge.locator}#${forgeChange.id} is closed; reopen it, or land locally (git config cabaret.landVia local)`,
    );
  }
  if (forgeChange.head !== change) {
    throw new UserError(
      `${forge.locator}#${forgeChange.id} merges ${JSON.stringify(forgeChange.head)}, not this change`,
    );
  }
  const parent = currentParent(change, entries);
  if (forgeChange.parent !== parent) {
    throw new UserError(
      `${forge.locator}#${forgeChange.id} merges into ${JSON.stringify(forgeChange.parent)}, ` +
        `not ${JSON.stringify(parent)}; run \`cabaret gh push\` to retarget it`,
    );
  }
  await backend.fetchBranch(parent);
  const prepared = await prepareLand(backend, change, entries, overrides);
  if (forgeChange.tip !== prepared.tip) {
    throw new UserError(
      `${forge.locator}#${forgeChange.id} is not at ${JSON.stringify(change)}'s tip; run \`cabaret gh push\` first`,
    );
  }
  const merge = await forge.landChange(forgeChange.id, method, prepared.tip, landTitle(change), landTrailer(change));
  await recordLand(backend, now, change, entries, prepared, merge);
  await backend.fetchBranch(parent);
  return merge.commit;
}

/**
 * Land `change` where `config` says: on the forge — merging its forge change —
 * when `landVia` is "forge", or "auto" with a forge change recorded in the
 * log; locally otherwise. Returns the forge change landed, or undefined for a
 * local land. `openForge` is consulted only for a forge land, so local lands
 * need no forge at all.
 */
export async function landAsConfigured(
  backend: Backend,
  now: () => TimestampMs,
  openForge: () => Promise<Forge>,
  config: Config,
  change: RefName,
  entries: readonly LogEntry[],
  overrides: LandOverrides,
): Promise<{ readonly forge: ForgeLocator; readonly id: ForgeChangeId } | undefined> {
  const viaForge =
    config.landVia === "forge" || (config.landVia === "auto" && currentForgeChange(entries) !== undefined);
  if (!viaForge) {
    await landChange(backend, now, change, entries, config.landMethod, overrides);
    return undefined;
  }
  const forge = await openForge();
  const forgeChange = await syncedForgeChange(backend, now, forge, change, entries);
  if (forgeChange === undefined) {
    throw new UserError(
      `no forge change for ${JSON.stringify(change)} on ${forge.locator}; run \`cabaret gh push\` first`,
    );
  }
  await landOnForge(backend, now, forge, change, entries, forgeChange, config.landMethod, overrides);
  return { forge: forge.locator, id: forgeChange.id };
}

/** What importing a forge change produced: a new change, or the discovery that its log already exists. */
export type ImportResult =
  | { readonly kind: "imported"; readonly change: RefName; readonly comments: number }
  | { readonly kind: "exists"; readonly change: RefName };

/**
 * Import forge change `id` as a change to review: fetch its head branch,
 * create the change owned by its author with its parent branch as the
 * change's parent, and pull its comments.
 */
export async function importChange(
  backend: Backend,
  now: () => TimestampMs,
  forge: Forge,
  id: ForgeChangeId,
): Promise<ImportResult> {
  const forgeChange = await forge.getChange(id);
  const change = forgeChange.head;
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
    { timestamp: now(), user, action: { kind: "set-parent", parent: forgeChange.parent } },
    {
      timestamp: now(),
      user,
      action: { kind: "set-base", base: await backend.mergeBase(forgeChange.parent, change) },
    },
    { timestamp: now(), user, action: { kind: "set-owner", owner: forgeChange.author } },
    { timestamp: now(), user, action: { kind: "set-forge", forge: forge.locator, id } },
    ...(await planPull(forge.locator, [], await forge.listComments(id))),
  ];
  // Without the land entry, a merged forge change's merge-base slides to its
  // own tip and the diff to review vanishes.
  const landing = observedLand(now, user, forgeChange, []);
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

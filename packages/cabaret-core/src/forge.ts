import {
  type Backend,
  type ChangeName,
  compareLogEntries,
  currentArchived,
  currentForgeChange,
  currentParent,
  currentReviewers,
  currentReviewing,
  type ForgeChange,
  type ForgeChangeId,
  type ForgeComment,
  type ForgeLocator,
  type ForgeMerge,
  formatLogEntry,
  type LogEntry,
  landedMerge,
  landTitle,
  landTrailer,
  observedForgeArchived,
  observedForgeParent,
  observedForgeReviewers,
  observedForgeReviewing,
  type Reviewing,
  type Revision,
  type TimestampMs,
  type UserName,
} from "./backend.js";
import type { Config, LandMethod } from "./config.js";
import { UserError } from "./error.js";
import {
  type LandOverrides,
  type LandPublication,
  landChange,
  prepareLand,
  recordLand,
  reparentLandedChildren,
} from "./ops.js";
import { currentSelf, isSelf, type Self } from "./self.js";

// WebCrypto and TextEncoder exist in every supported runtime (Node and
// browsers alike) but are absent from the bare es2025 lib this
// platform-agnostic package compiles against.
declare const crypto: {
  readonly subtle: { digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer> };
};
declare class TextEncoder {
  encode(input: string): Uint8Array;
}

/** An open forge change with what importing it needs, as one bulk sweep carries it. */
export interface OpenChange {
  readonly change: ForgeChange;
  /** The change-level comments, oldest first; may be capped at the first hundred or so. */
  readonly comments: readonly ForgeComment[];
  /** Whether `comments` was capped; full readers fall back to `listComments`. */
  readonly commentsTruncated: boolean;
}

/**
 * The operations Cabaret needs from a code forge (GitHub, GitLab, …).
 * Implementations live in `cabaret-github` and friends.
 *
 * Rendering never calls a forge: it reads change logs, which `fetchForge` —
 * behind `cab fetch` — populates from the forge.
 */
export interface Forge {
  /** Identifies this forge and repository, e.g. "github.com/test-org/widgets". */
  readonly locator: ForgeLocator;

  /**
   * The forge's reading of the current user: the account its credentials
   * authenticate, with the emails the account's profile shows as aliases.
   */
  currentSelf(): Promise<Self>;

  /**
   * Every open change with its comments, in no particular order. Taken in one
   * sweep so a fetch costs a handful of API calls however many changes are
   * open; in return each change's comments may be capped, which
   * `commentsTruncated` reports.
   */
  fetchOpenChanges(): Promise<readonly OpenChange[]>;

  /** The open change with head `branch`, or undefined if there is none. */
  findChange(branch: ChangeName): Promise<ForgeChange | undefined>;

  getChange(id: ForgeChangeId): Promise<ForgeChange>;

  /** Open a change merging `head` into `parent`, as a draft when `draft`. `head` must already be pushed. */
  createChange(head: ChangeName, parent: ChangeName, title: string, draft: boolean): Promise<ForgeChange>;

  /** Retarget an open change's parent branch. */
  setParent(id: ForgeChangeId, parent: ChangeName): Promise<void>;

  /** Mark an open change as a draft, or as ready for review. */
  setDraft(id: ForgeChangeId, draft: boolean): Promise<void>;

  /** Close an open change without merging, or reopen a closed one. */
  setState(id: ForgeChangeId, state: "open" | "closed"): Promise<void>;

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
  landChange(id: ForgeChangeId, method: LandMethod, tip: Revision, title: string, message: string): Promise<ForgeMerge>;

  /** The change-level comments, oldest first. */
  listComments(id: ForgeChangeId): Promise<readonly ForgeComment[]>;

  /** Post a change-level comment. */
  addComment(id: ForgeChangeId, body: string): Promise<void>;

  /**
   * Request review from each of `add` and withdraw it from each of `remove`,
   * identified as Cabaret knows them; the implementation maps identities back
   * to forge accounts. Fails when an identity has no such account. Best
   * effort within the forge's model: GitHub, for one, cannot withdraw a
   * reviewer who has already reviewed.
   */
  setReviewers(id: ForgeChangeId, add: readonly UserName[], remove: readonly UserName[]): Promise<void>;
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
    const source = entry.source;
    if (source === undefined) {
      local.set(await commentHash(entry), entry);
    } else if (source.forge === forge && source.id !== undefined) {
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
    const edits = latest?.action.edits ?? hash;
    additions.push({
      timestamp: comment.updatedAt,
      user: comment.author,
      source: { forge, id: comment.id },
      action: { kind: "comment", text, ...(edits === undefined ? {} : { edits }) },
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
    if (entry.source !== undefined) {
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

/** One reviewer entry stamped with the forge as its source: a mirror of the forge's state, and the observation of it. */
function reviewerObservation(
  now: () => TimestampMs,
  user: UserName,
  forge: ForgeLocator,
  reviewer: UserName,
  member: boolean,
): LogEntry {
  return {
    timestamp: now(),
    user,
    source: { forge },
    action: { kind: member ? "add-reviewer" : "remove-reviewer", reviewer },
  };
}

/**
 * The entries mirroring the forge's reviewer set into the log: one per user
 * whose forge membership differs from the last observed one. Comparing
 * against the observation, never against local state, is what keeps a local
 * add or remove awaiting its push from being overridden — only a forge that
 * moved since last observed mirrors in, and by timestamp it wins.
 */
export function planReviewerPull(
  now: () => TimestampMs,
  user: UserName,
  forge: ForgeLocator,
  entries: readonly LogEntry[],
  reviewers: readonly UserName[],
): readonly LogEntry[] {
  const observed = observedForgeReviewers(entries, forge);
  const onForge = new Set(reviewers);
  return [...new Set([...onForge, ...observed])]
    .sort()
    .filter((reviewer) => onForge.has(reviewer) !== observed.has(reviewer))
    .map((reviewer) => reviewerObservation(now, user, forge, reviewer, onForge.has(reviewer)));
}

/**
 * What a push must do to the forge's reviewer set, given a log that has
 * already absorbed `planReviewerPull`'s mirror: with observation and forge
 * agreeing, any difference left between the log's reviewers and the forge's
 * is local intent. `add` and `remove` are the requests to make, sorted by
 * name; `observations` record the state those requests leave the forge in,
 * so the next pull does not mirror this push back.
 */
export function planReviewerPush(
  now: () => TimestampMs,
  user: UserName,
  forge: ForgeLocator,
  entries: readonly LogEntry[],
  reviewers: readonly UserName[],
): {
  readonly add: readonly UserName[];
  readonly remove: readonly UserName[];
  readonly observations: readonly LogEntry[];
} {
  const local = new Set(currentReviewers(entries));
  const onForge = new Set(reviewers);
  const add = [...local].filter((reviewer) => !onForge.has(reviewer)).sort();
  const remove = [...onForge].filter((reviewer) => !local.has(reviewer)).sort();
  return {
    add,
    remove,
    observations: [
      ...add.map((reviewer) => reviewerObservation(now, user, forge, reviewer, true)),
      ...remove.map((reviewer) => reviewerObservation(now, user, forge, reviewer, false)),
    ],
  };
}

/** One reviewing entry stamped with the forge as its source: a mirror of the forge's draft boundary, and the observation of it. */
function reviewingObservation(
  now: () => TimestampMs,
  user: UserName,
  forge: ForgeLocator,
  reviewing: Reviewing,
): LogEntry {
  return {
    timestamp: now(),
    user,
    source: { forge },
    action: { kind: "set-reviewing", reviewing },
  };
}

/**
 * The entry mirroring the forge's draft state into the log, when the forge
 * crossed the draft boundary since last observed. A forge expresses reviewing
 * only as that boolean, so a draft mirrors in as "none" and a change marked
 * ready as "everyone" — the forge-faithful reading, under which obligations
 * alone decide who is asked. Comparing against the observation, never local
 * state, is what keeps a local `set-reviewing` awaiting its push from being
 * overridden; a forge never observed mirrors nothing, and a push settles the
 * sides.
 */
export function planReviewingPull(
  now: () => TimestampMs,
  user: UserName,
  forge: ForgeLocator,
  entries: readonly LogEntry[],
  draft: boolean,
): readonly LogEntry[] {
  const observed = observedForgeReviewing(entries, forge);
  if (observed === undefined || (observed === "none") === draft) {
    return [];
  }
  return [reviewingObservation(now, user, forge, draft ? "none" : "everyone")];
}

/**
 * What a push must do to the forge's draft state, given a log that has
 * already absorbed `planReviewingPull`'s mirror: with observation and forge
 * agreeing, any draft-boundary difference left between the log's reviewing
 * set and the forge is local intent. `draft` is the state to set, when one
 * must be; `observations` record the state that request leaves the forge in —
 * the local reviewing set, whose boundary the forge now agrees with — so the
 * next pull does not mirror this push back.
 */
export function planReviewingPush(
  now: () => TimestampMs,
  user: UserName,
  forge: ForgeLocator,
  entries: readonly LogEntry[],
  draft: boolean,
): { readonly draft?: boolean | undefined; readonly observations: readonly LogEntry[] } {
  const local = currentReviewing(entries);
  if ((local === "none") === draft) {
    return { observations: [] };
  }
  return { draft: local === "none", observations: [reviewingObservation(now, user, forge, local)] };
}

/** One archived entry stamped with the forge as its source: a mirror of the forge's open/closed state, and the observation of it. */
function archivedObservation(now: () => TimestampMs, user: UserName, forge: ForgeLocator, archived: boolean): LogEntry {
  return {
    timestamp: now(),
    user,
    source: { forge },
    action: { kind: "set-archived", archived },
  };
}

/**
 * The entry mirroring the forge's open/closed state into the log as the
 * change's archived state, when the forge crossed it since last observed. A
 * forge change is only ever imported or opened while open, so a log with no
 * observation reads as having observed open. Comparing against the
 * observation, never local state, is what keeps a local `set-archived`
 * awaiting its push from being overridden; a push settles the sides.
 */
export function planArchivedPull(
  now: () => TimestampMs,
  user: UserName,
  forge: ForgeLocator,
  entries: readonly LogEntry[],
  closed: boolean,
): readonly LogEntry[] {
  const observed = observedForgeArchived(entries, forge) ?? false;
  if (observed === closed) {
    return [];
  }
  return [archivedObservation(now, user, forge, closed)];
}

/**
 * What a push must do to the forge's open/closed state, given a log that has
 * already absorbed `planArchivedPull`'s mirror: with observation and forge
 * agreeing, any difference left between the log's archived state and the
 * forge is local intent. `state` is the state to set, when one must be;
 * `observations` record the state that request leaves the forge in — the
 * local archived state, which the forge now agrees with — so the next pull
 * does not mirror this push back.
 */
export function planArchivedPush(
  now: () => TimestampMs,
  user: UserName,
  forge: ForgeLocator,
  entries: readonly LogEntry[],
  closed: boolean,
): { readonly state?: "open" | "closed" | undefined; readonly observations: readonly LogEntry[] } {
  const local = currentArchived(entries);
  if (local === closed) {
    return { observations: [] };
  }
  return { state: local ? "closed" : "open", observations: [archivedObservation(now, user, forge, local)] };
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
  forge: ForgeLocator,
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
    source: { forge },
    action: { kind: "land", merge: commit, ...(parents > 1 ? {} : { tip: forgeChange.tip }) },
  };
}

/**
 * The entries adopting `forgeChange` as `change`'s forge change: the
 * `set-forge`, plus a baseline observation of each attribute on which the two
 * sides already agree — the parent, and the reviewing set's draft boundary —
 * so a later forge-side move is seen as one. Disagreeing attributes record no
 * observation; a push or a later pull settles them.
 */
function adoptionEntries(
  now: () => TimestampMs,
  user: UserName,
  locator: ForgeLocator,
  forgeChange: ForgeChange,
  change: ChangeName,
  entries: readonly LogEntry[],
): LogEntry[] {
  const adoption: LogEntry[] = [
    {
      timestamp: now(),
      user,
      source: { forge: locator },
      action: { kind: "set-forge", forge: locator, id: forgeChange.id },
    },
  ];
  if (forgeChange.parent === currentParent(change, entries)) {
    adoption.push({
      timestamp: now(),
      user,
      source: { forge: locator },
      action: { kind: "set-parent", parent: forgeChange.parent },
    });
  }
  const reviewing = currentReviewing(entries);
  if ((reviewing === "none") === forgeChange.draft) {
    adoption.push(reviewingObservation(now, user, locator, reviewing));
  }
  return adoption;
}

/**
 * The forge change `change` syncs with: the log's `set-forge` when it names
 * one on this forge, else the change's branch's open forge change, adopted
 * with a `set-forge` entry. Undefined when the forge has none either.
 */
export async function syncedForgeChange(
  backend: Backend,
  now: () => TimestampMs,
  user: UserName,
  forge: Forge,
  change: ChangeName,
  entries: readonly LogEntry[],
): Promise<ForgeChange | undefined> {
  const recorded = currentForgeChange(entries);
  if (recorded !== undefined && recorded.forge === forge.locator) {
    return forge.getChange(recorded.id);
  }
  const found = await forge.findChange(change);
  if (found !== undefined) {
    await backend.appendLog(change, adoptionEntries(now, user, forge.locator, found, change, entries));
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
  change: ChangeName,
  entries: readonly LogEntry[],
  forgeChange: ForgeChange,
  method: LandMethod,
  overrides: LandOverrides,
): Promise<Revision> {
  if (forgeChange.state === "merged") {
    throw new UserError(`${forge.locator}#${forgeChange.id} was already merged; run \`cab sync\` to record the land`);
  }
  if (forgeChange.state === "closed") {
    throw new UserError(
      `${forge.locator}#${forgeChange.id} is closed; reopen it, or land locally (cab config land-via local)`,
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
        `not ${JSON.stringify(parent)}; run \`cab sync\` to retarget it`,
    );
  }
  await backend.fetch(parent);
  const prepared = await prepareLand(backend, change, entries, overrides);
  if (forgeChange.tip !== prepared.tip) {
    throw new UserError(
      `${forge.locator}#${forgeChange.id} is not at ${JSON.stringify(change)}'s tip; run \`cab sync\` first`,
    );
  }
  const merge = await forge.landChange(forgeChange.id, method, prepared.tip, landTitle(change), landTrailer(change));
  await recordLand(backend, now, change, entries, prepared, merge);
  await backend.fetch(parent);
  return merge.commit;
}

/** What a land did beyond the landing itself, for hosts to narrate. */
export interface LandOutcome {
  /** The forge change merged, or undefined for a local land. */
  readonly merged: { readonly forge: ForgeLocator; readonly id: ForgeChangeId } | undefined;
  /** The landed change's children, moved onto `onto` to follow the code; undefined when none moved. */
  readonly reparented:
    | {
        readonly onto: ChangeName;
        readonly children: readonly ChangeName[];
        /** The children's forge changes now targeting `onto`; empty for a local land. */
        readonly retargeted: readonly {
          readonly change: ChangeName;
          readonly forge: ForgeLocator;
          readonly id: ForgeChangeId;
        }[];
      }
    | undefined;
  /** How a local land's parent advance reached origin; undefined for a forge land, whose merge origin already holds. */
  readonly publication: LandPublication | undefined;
}

/**
 * Retarget the still-open forge changes of `children` — a landed change's
 * reparented children — onto `onto`, so each child comes out of the land
 * ready to review or land rather than waiting on a sync to move its forge
 * change off the landed branch. Each new parent is recorded as an
 * observation, so a later absorb can tell a forge-side retarget from the
 * state this side left behind; a forge that already followed the move
 * records the observation alone. Children tracked on other forges, or whose
 * forge changes are closed, are left for their own sync. Returns what now
 * targets `onto`, in `children` order.
 */
async function retargetLandedChildren(
  backend: Backend,
  now: () => TimestampMs,
  forge: Forge,
  children: readonly ChangeName[],
  onto: ChangeName,
): Promise<NonNullable<LandOutcome["reparented"]>["retargeted"]> {
  const user = await backend.currentUser();
  const retargeted: { change: ChangeName; forge: ForgeLocator; id: ForgeChangeId }[] = [];
  for (const child of children) {
    const tracked = currentForgeChange(await backend.readLog(child));
    if (tracked?.forge !== forge.locator) {
      continue;
    }
    const forgeChange = await forge.getChange(tracked.id);
    if (forgeChange.state !== "open") {
      continue;
    }
    if (forgeChange.parent !== onto) {
      await forge.setParent(tracked.id, onto);
    }
    await backend.appendLog(child, [
      { timestamp: now(), user, source: { forge: forge.locator }, action: { kind: "set-parent", parent: onto } },
    ]);
    retargeted.push({ change: child, forge: forge.locator, id: tracked.id });
  }
  return retargeted;
}

/**
 * Land `change` where `config` says: on the forge — merging its forge change —
 * when `landVia` is "forge", or "auto" with a forge change recorded in the
 * log; locally otherwise. `openForge` is consulted only for a forge land, so
 * local lands need no forge at all. Either way the landed change's children
 * are then reparented onto its parent, where their code now lives; a forge
 * land also retargets their forge changes to follow.
 */
export async function landAsConfigured(
  backend: Backend,
  now: () => TimestampMs,
  openForge: () => Promise<Forge>,
  config: Config,
  change: ChangeName,
  entries: readonly LogEntry[],
  overrides: LandOverrides,
): Promise<LandOutcome> {
  const viaForge =
    config.landVia === "forge" || (config.landVia === "auto" && currentForgeChange(entries) !== undefined);
  let merged: LandOutcome["merged"];
  let publication: LandOutcome["publication"];
  let forge: Forge | undefined;
  if (!viaForge) {
    publication = await landChange(backend, now, change, entries, config.landMethod, overrides);
  } else {
    forge = await openForge();
    const forgeChange = await syncedForgeChange(backend, now, await backend.currentUser(), forge, change, entries);
    if (forgeChange === undefined) {
      throw new UserError(`no forge change for ${JSON.stringify(change)} on ${forge.locator}; run \`cab sync\` first`);
    }
    await landOnForge(backend, now, forge, change, entries, forgeChange, config.landMethod, overrides);
    merged = { forge: forge.locator, id: forgeChange.id };
  }
  const onto = currentParent(change, entries);
  const children = await reparentLandedChildren(backend, now, change, onto);
  const retargeted = forge === undefined ? [] : await retargetLandedChildren(backend, now, forge, children, onto);
  return { merged, reparented: children.length > 0 ? { onto, children, retargeted } : undefined, publication };
}

/** One thing a fetch did, as it happens, so hosts can narrate in their own voice. */
export type FetchEvent =
  | { readonly kind: "aliased"; readonly alias: UserName }
  | { readonly kind: "advanced"; readonly change: ChangeName }
  | { readonly kind: "imported"; readonly id: ForgeChangeId; readonly change: ChangeName; readonly comments: number }
  | { readonly kind: "skipped"; readonly id: ForgeChangeId; readonly change: ChangeName; readonly reason: string }
  | ({ readonly kind: "absorbed"; readonly id: ForgeChangeId; readonly change: ChangeName } & AbsorbResult)
  | { readonly kind: "archived"; readonly id: ForgeChangeId; readonly change: ChangeName }
  | { readonly kind: "pruned"; readonly id: ForgeChangeId; readonly change: ChangeName };

/** What absorbing the forge's side of a change recorded, for hosts to narrate. */
export interface AbsorbResult {
  /** How many comments were imported: new ones, and new versions of edited ones. */
  readonly comments: number;
  /** How many reviewer memberships the forge moved since last observed. */
  readonly reviewers: number;
  /** Whether a forge-side merge was recorded as the change's land. */
  readonly landed: boolean;
  /** The parent a forge-side retarget mirrored in, when one did. */
  readonly parent?: ChangeName | undefined;
  /** The reviewing set a forge-side draft toggle mirrored in, when one did. */
  readonly reviewing?: Reviewing | undefined;
  /** The archived state a forge-side close or reopen mirrored in, when one did. */
  readonly archived?: boolean | undefined;
}

/**
 * Absorb one tracked change's forge activity into its log: comments the log
 * lacks — new ones, and new versions of ones edited in place — the land a
 * merged forge change implies, and a forge-side retarget as an observed
 * `set-parent`. Only a forge parent that moved since last observed mirrors
 * in, so a local reparent awaiting publication is never overridden — and a
 * forge-side reviewer change as mirrored add/remove entries, a forge-side
 * draft toggle as a mirrored `set-reviewing`, and a forge-side close or
 * reopen as a mirrored `set-archived`, on the same observation principle.
 * `comments` spares the `listComments` call when the caller already holds
 * the full discussion.
 */
export async function absorbForgeChange(
  backend: Backend,
  now: () => TimestampMs,
  user: UserName,
  forge: Forge,
  change: ChangeName,
  entries: readonly LogEntry[],
  forgeChange: ForgeChange,
  comments?: readonly ForgeComment[],
): Promise<AbsorbResult> {
  const additions = [
    ...(await planPull(forge.locator, entries, comments ?? (await forge.listComments(forgeChange.id)))),
  ];
  const landing = observedLand(now, user, forge.locator, forgeChange, entries);
  if (landing !== undefined) {
    additions.push(landing);
  }
  const observed = observedForgeParent(entries, forge.locator);
  const retargeted = forgeChange.state === "open" && observed !== undefined && observed !== forgeChange.parent;
  if (retargeted) {
    additions.push({
      timestamp: now(),
      user,
      source: { forge: forge.locator },
      action: { kind: "set-parent", parent: forgeChange.parent },
    });
  }
  // A change no longer open keeps the reviewers it had: obligations only
  // gate landing, so there is nothing left to mirror for.
  const mirrored =
    forgeChange.state === "open" ? planReviewerPull(now, user, forge.locator, entries, forgeChange.reviewers) : [];
  additions.push(...mirrored);
  const reviewing =
    forgeChange.state === "open" ? planReviewingPull(now, user, forge.locator, entries, forgeChange.draft) : [];
  additions.push(...reviewing);
  // A closed forge change mirrors in as archived, a reopened one as live; a
  // merged one has landed, which the land entry already records.
  const archived =
    forgeChange.state === "merged"
      ? []
      : planArchivedPull(now, user, forge.locator, entries, forgeChange.state === "closed");
  additions.push(...archived);
  if (additions.length > 0) {
    await backend.appendLog(change, additions);
  }
  const mirroredReviewing = reviewing[0]?.action;
  const mirroredArchived = archived[0]?.action;
  return {
    comments: additions.filter(({ action }) => action.kind === "comment").length,
    reviewers: mirrored.length,
    landed: landing !== undefined,
    ...(retargeted ? { parent: forgeChange.parent } : {}),
    ...(mirroredReviewing?.kind === "set-reviewing" ? { reviewing: mirroredReviewing.reviewing } : {}),
    ...(mirroredArchived?.kind === "set-archived" ? { archived: mirroredArchived.archived } : {}),
  };
}

/**
 * Whether every entry mirrors the forge: imports and observations all carry a
 * forge source, and anything without one — a review or forget mark, a local
 * comment, a reparent or owner transfer someone typed — is a sign somebody
 * engaged with the change.
 */
function pureImport(entries: readonly LogEntry[]): boolean {
  return entries.every(({ source }) => source !== undefined);
}

/**
 * Fetch everything remote, forge included: refresh origin's copies,
 * fast-forward branches whose moves lose nothing (as `advanceBranches`),
 * merge every change's log with origin's, then absorb the forge wholesale —
 * import every open forge change that has no log yet as a change to review
 * (owned by its author, parented on its target branch, its discussion
 * imported), refresh every tracked change (as `absorbForgeChange`), mirror
 * closed forge changes in as archived, and prune changes whose forge change
 * closed before anyone engaged with them. Returns how many forge changes
 * are open.
 *
 * The account the forge's credentials authenticate — and each email its
 * profile shows — is declared a `cabaret.alias` when it does not already
 * count as the current user, so changes those identities authored or are
 * asked to review read as theirs. The association is the repository's —
 * another repository may front a different account — so the declarations
 * land in local config.
 *
 * Everything is reported through `onEvent` as it happens. Two machines
 * fetching concurrently import the same changes twice; the union merge that
 * log syncing applies keeps both machines' entries, current-stamped so the
 * latest observation of the forge wins every read.
 */
export async function fetchForge(
  backend: Backend,
  now: () => TimestampMs,
  forge: Forge,
  onEvent: (event: FetchEvent) => void,
): Promise<{ readonly open: number }> {
  const forgeSelf = await forge.currentSelf();
  const self = await currentSelf(backend);
  const user = self.user;
  for (const alias of [forgeSelf.user, ...forgeSelf.aliases]) {
    if (!isSelf(self, alias)) {
      await backend.configAdd("cabaret.alias", alias, "local");
      onEvent({ kind: "aliased", alias });
    }
  }

  // The fetch begins with origin: its copies are what every reading below —
  // and every summary after — consults.
  await backend.fetchOrigin();
  for (const change of await backend.advanceBranches()) {
    onEvent({ kind: "advanced", change });
  }
  // Adopt before importing: a change another machine already imported and
  // published arrives as a log here, keeping this fetch's import phase to
  // forge changes nobody holds.
  await backend.syncLogs();
  const tracked = await backend.listChanges();
  const existing = new Set(tracked);

  const open = await forge.fetchOpenChanges();
  // Heads sharing a branch collapse to the lowest id, so every machine
  // imports the same change for a branch with several open forge changes.
  const byHead = new Map<ChangeName, OpenChange>();
  for (const candidate of open) {
    const prev = byHead.get(candidate.change.head);
    if (prev === undefined || candidate.change.id < prev.change.id) {
      byHead.set(candidate.change.head, candidate);
    }
  }
  const byId = new Map(open.map((candidate) => [candidate.change.id, candidate]));

  // Import: every open forge change whose head has no log. Import creates
  // logs and nothing else: the change is born reading origin's copy of its
  // branch, like any adopted change, and the branch materializes on
  // engagement. A head origin has no branch for — a fork's, say — cannot be
  // read and is skipped.
  const imports = [...byHead.values()].filter(({ change }) => !existing.has(change.head));
  for (const { change: forgeChange, comments, commentsTruncated } of imports) {
    const headTip = (await backend.tip(forgeChange.head)) ?? (await backend.originTip(forgeChange.head));
    const parentTip = (await backend.tip(forgeChange.parent)) ?? (await backend.originTip(forgeChange.parent));
    if (headTip === undefined || parentTip === undefined) {
      const missing = headTip === undefined ? forgeChange.head : forgeChange.parent;
      onEvent({
        kind: "skipped",
        id: forgeChange.id,
        change: forgeChange.head,
        reason: `origin has no branch ${JSON.stringify(missing)}`,
      });
      continue;
    }
    const full = commentsTruncated ? await forge.listComments(forgeChange.id) : comments;
    // Everything an import writes carries the forge as its source: none of it
    // is anyone here engaging with the change.
    const source = { forge: forge.locator };
    const additions: LogEntry[] = [
      { timestamp: now(), user, source, action: { kind: "set-parent", parent: forgeChange.parent } },
      {
        timestamp: now(),
        user,
        source,
        action: { kind: "set-base", base: await backend.mergeBase(parentTip, headTip) },
      },
      { timestamp: now(), user, source, action: { kind: "set-owner", owner: forgeChange.author } },
      { timestamp: now(), user, source, action: { kind: "set-forge", forge: forge.locator, id: forgeChange.id } },
      // The forge's draft boundary, read the forge-faithful way — a draft is
      // not ready for anyone, a ready change is open to everyone — and the
      // baseline later pulls compare the forge against.
      reviewingObservation(now, user, forge.locator, forgeChange.draft ? "none" : "everyone"),
      ...planReviewerPull(now, user, forge.locator, [], forgeChange.reviewers),
      ...(await planPull(forge.locator, [], full)),
    ];
    await backend.appendLog(forgeChange.head, additions);
    onEvent({
      kind: "imported",
      id: forgeChange.id,
      change: forgeChange.head,
      comments: additions.filter(({ action }) => action.kind === "comment").length,
    });
  }

  // Refresh: every change tracked before the import phase, so a fresh import
  // is not immediately re-pulled as a no-op. Each change's refresh reads and
  // appends only its own log, so refreshing the batch concurrently costs one
  // round trip's latency, not `tracked.length`'s; `onEvent` fires in
  // whatever order the changes finish in, not `tracked`'s.
  type PruneCandidate = { readonly change: ChangeName; readonly id: ForgeChangeId; readonly archived: boolean };
  const refreshed = await Promise.all(
    tracked.map(async (change): Promise<PruneCandidate | undefined> => {
      const entries = await backend.readLog(change);
      if (landedMerge(entries) !== undefined) {
        return undefined;
      }
      const recorded = currentForgeChange(entries);
      let bulk: OpenChange | undefined;
      let forgeChange: ForgeChange;
      if (recorded !== undefined) {
        if (recorded.forge !== forge.locator) {
          return undefined;
        }
        bulk = byId.get(recorded.id);
        // A tracked change absent from the open sweep merged or closed since;
        // fetched live so this fetch still records its land.
        forgeChange = bulk?.change ?? (await forge.getChange(recorded.id));
      } else {
        // An untracked branch's open forge change is adopted without asking
        // the forge change by change.
        bulk = byHead.get(change);
        if (bulk === undefined) {
          return undefined;
        }
        forgeChange = bulk.change;
        await backend.appendLog(change, adoptionEntries(now, user, forge.locator, forgeChange, change, entries));
      }
      if (forgeChange.state === "closed") {
        // Mirror the close in as archived before judging engagement: the
        // observation carries a source, so a pure import stays prunable.
        const mirror = planArchivedPull(now, user, forge.locator, entries, true);
        if (mirror.length > 0) {
          await backend.appendLog(change, mirror);
        }
        return { change, id: forgeChange.id, archived: mirror.length > 0 };
      }
      const comments = bulk !== undefined && !bulk.commentsTruncated ? bulk.comments : undefined;
      const absorbed = await absorbForgeChange(backend, now, user, forge, change, entries, forgeChange, comments);
      onEvent({ kind: "absorbed", id: forgeChange.id, change, ...absorbed });
      return undefined;
    }),
  );
  const pruneCandidates = refreshed.filter((candidate): candidate is PruneCandidate => candidate !== undefined);

  // Publish what this fetch imported and appended.
  await backend.syncLogs();

  // Prune closed changes nobody engaged with, judged after the closing sync
  // so engagement published from another machine counts. An engaged change
  // keeps its log; the close it mirrored in as archived is reported instead.
  for (const { change, id, archived } of pruneCandidates) {
    if (pureImport(await backend.readLog(change))) {
      await backend.deleteLog(change);
      onEvent({ kind: "pruned", id, change });
    } else if (archived) {
      onEvent({ kind: "archived", id, change });
    }
  }

  return { open: open.length };
}

/** What publishing settled on the forge, so hosts can narrate in their own voice. */
export interface PublishResult {
  readonly id: ForgeChangeId;
  /** Whether publishing opened the forge change. */
  readonly opened: boolean;
  /** How many reviewer memberships were updated on the forge. */
  readonly reviewers: number;
  /** How many comments were posted. */
  readonly comments: number;
  /** The draft state set on the forge, when one was. */
  readonly draft?: boolean | undefined;
  /** The open/closed state set on the forge, when one was. */
  readonly state?: "open" | "closed" | undefined;
  /** The archived state a forge-side close or reopen mirrored in, when one did. */
  readonly archived?: boolean | undefined;
}

/**
 * Publish `change`'s activity to `found`, its forge change: open one if
 * there is none (merging into the change's parent, a draft when nobody is
 * reviewing), close or reopen it to match the change's archived state,
 * retarget it to the parent, settle reviewers and the draft boundary both
 * ways, and post the change's comments the forge lacks. The branch must
 * already be pushed. An archived change with no forge change is already
 * converged — archiving asks for no new one — and publishes nothing.
 */
export async function publishForgeChange(
  backend: Backend,
  now: () => TimestampMs,
  forge: Forge,
  change: ChangeName,
  entries: readonly LogEntry[],
  found: ForgeChange | undefined,
): Promise<PublishResult | undefined> {
  const parent = currentParent(change, entries);
  const user = await backend.currentUser();
  // Whenever publishing sets the forge's parent — at creation or by a
  // retarget — the log records the observation, so a later absorb can
  // tell a forge-side retarget from the state this side left behind.
  const observation = (): LogEntry => ({
    timestamp: now(),
    user,
    source: { forge: forge.locator },
    action: { kind: "set-parent", parent },
  });
  let forgeChange = found;
  const opened = forgeChange === undefined;
  if (forgeChange === undefined) {
    if (currentArchived(entries)) {
      return undefined;
    }
    forgeChange = await forge.createChange(change, parent, change, currentReviewing(entries) === "none");
    await backend.appendLog(change, [
      {
        timestamp: now(),
        user,
        source: { forge: forge.locator },
        action: { kind: "set-forge", forge: forge.locator, id: forgeChange.id },
      },
      observation(),
      // The creation set the forge's draft boundary to the local reviewing
      // set's; recorded so a later absorb can tell a forge-side toggle from
      // the state this side left behind.
      reviewingObservation(now, user, forge.locator, currentReviewing(entries)),
    ]);
  }
  // Sync the open/closed state before anything that needs the forge change
  // open: a local archive closes it, a local unarchive reopens it, and what
  // follows settles against the state publishing leaves behind. A merged forge
  // change has landed, so its state is nobody's to move.
  let state: "open" | "closed" | undefined;
  let mirroredArchived: boolean | undefined;
  if (forgeChange.state !== "merged") {
    const closed = forgeChange.state === "closed";
    const current = await backend.readLog(change);
    const mirror = planArchivedPull(now, user, forge.locator, current, closed);
    const mirrored = mirror[0]?.action;
    mirroredArchived = mirrored?.kind === "set-archived" ? mirrored.archived : undefined;
    const plan = planArchivedPush(now, user, forge.locator, [...current, ...mirror], closed);
    state = plan.state;
    if (state !== undefined) {
      await forge.setState(forgeChange.id, state);
    }
    const additions = [...mirror, ...plan.observations];
    if (additions.length > 0) {
      await backend.appendLog(change, additions);
    }
  }
  const open = (state ?? forgeChange.state) === "open";
  if (open && forgeChange.parent !== parent) {
    await forge.setParent(forgeChange.id, parent);
    await backend.appendLog(change, [observation()]);
  }
  let reviewers = 0;
  let draft: boolean | undefined;
  if (open) {
    // Absorb forge-side reviewer and draft changes first, so what remains
    // between the log and the forge is exactly this side's intent.
    const current = await backend.readLog(change);
    const mirrored = planReviewerPull(now, user, forge.locator, current, forgeChange.reviewers);
    const plan = planReviewerPush(now, user, forge.locator, [...current, ...mirrored], forgeChange.reviewers);
    reviewers = plan.add.length + plan.remove.length;
    if (reviewers > 0) {
      await forge.setReviewers(forgeChange.id, plan.add, plan.remove);
    }
    const reviewingMirror = planReviewingPull(now, user, forge.locator, current, forgeChange.draft);
    const reviewingPlan = planReviewingPush(
      now,
      user,
      forge.locator,
      [...current, ...reviewingMirror],
      forgeChange.draft,
    );
    draft = reviewingPlan.draft;
    if (draft !== undefined) {
      await forge.setDraft(forgeChange.id, draft);
    }
    const additions = [...mirrored, ...plan.observations, ...reviewingMirror, ...reviewingPlan.observations];
    if (additions.length > 0) {
      await backend.appendLog(change, additions);
    }
  }
  const bodies = await planPush(entries, await forge.listComments(forgeChange.id), user);
  for (const body of bodies) {
    await forge.addComment(forgeChange.id, body);
  }
  return {
    id: forgeChange.id,
    opened,
    reviewers,
    comments: bodies.length,
    ...(draft === undefined ? {} : { draft }),
    ...(state === undefined ? {} : { state }),
    ...(mirroredArchived === undefined ? {} : { archived: mirroredArchived }),
  };
}

/** One comment as displayed: the latest version of its group. */
export interface ChangeComment {
  readonly timestamp: TimestampMs;
  readonly user: UserName;
  readonly text: string;
}

/**
 * The comments of a change as displayed, oldest first. Versions of one
 * comment — entries whose `edits` names the entry they supersede, and imports
 * sharing a source id — collapse to the version with the greatest timestamp.
 */
export async function currentComments(entries: readonly LogEntry[]): Promise<readonly ChangeComment[]> {
  const groups = new Map<string, { first: TimestampMs; latest: CommentEntry }>();
  for (const entry of commentEntries(entries)) {
    const { source } = entry;
    const key =
      entry.action.edits ?? (source?.id === undefined ? await commentHash(entry) : `${source.forge}#${source.id}`);
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

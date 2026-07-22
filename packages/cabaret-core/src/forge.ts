import type { Branded } from "cabaret-util";
import {
  type Backend,
  type ChangeId,
  type ChangeName,
  compareLogEntries,
  currentArchived,
  currentForgeChange,
  currentName,
  currentParent,
  currentPermanent,
  currentReviewers,
  currentReviewing,
  type ForgeChange,
  type ForgeChangeId,
  type ForgeComment,
  type ForgeLocator,
  type ForgeMerge,
  finished,
  formatLogEntry,
  type LogEntry,
  landTitle,
  landTrailer,
  observedForgeArchived,
  observedForgeParent,
  observedForgeReviewers,
  observedForgeReviewing,
  parseChangeId,
  type Reviewing,
  type Revision,
  type TimestampMs,
  type UserName,
} from "./backend.js";
import type { Config, LandMethod } from "./config.js";
import { UserError } from "./error.js";
import { allChanges, type Change, requireNamed } from "./naming.js";
import {
  type LandOverrides,
  type LandPublication,
  landChange,
  prepareLand,
  pushAdvances,
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

/** A forge change with what absorbing it needs, as one bulk sweep carries it. */
export interface SweptChange {
  readonly change: ForgeChange;
  /** The change-level comments, oldest first; may be capped at the first hundred or so. */
  readonly comments: readonly ForgeComment[];
  /** Whether `comments` was capped; full readers fall back to `listComments`. */
  readonly commentsTruncated: boolean;
}

/**
 * Where a sweep's reading of the forge ends — the forge's own clock, as
 * epoch milliseconds — so a later sweep can resume there, on this machine
 * or another. Minted overlapping: absorption is idempotent, so a cursor
 * claims a little less than its sweep read, and copies join by max.
 */
export type ForgeCursor = Branded<string, "ForgeCursor">;

export function forgeCursor(raw: string): ForgeCursor {
  if (!Number.isFinite(Number(raw)) || raw === "") {
    throw new Error(`not a forge cursor: ${JSON.stringify(raw)}`);
  }
  return raw as ForgeCursor;
}

/** What one `fetchChanges` sweep saw. */
export interface ForgeSweep {
  /**
   * What absence from `changes` means: an "open" sweep carried every open
   * change, so an absent tracked change merged or closed; a "since" sweep
   * carried everything the forge touched after its cursor, closed and merged
   * changes included, so an absent change is untouched.
   */
  readonly coverage: "open" | "since";
  readonly changes: readonly SweptChange[];
  /** Resumes the next sweep; undefined when this one saw nothing to mint from. */
  readonly cursor: ForgeCursor | undefined;
}

/**
 * The operations Cabaret needs from a code forge (GitHub, GitLab, …).
 * Implementations live in `cabaret-forges`.
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
   * A sweep of the forge's changes with their comments, in no particular
   * order. Given the cursor a prior sweep minted, an adapter may cover just
   * what the forge touched since; without one, or when it cannot resume, it
   * covers every open change. Either way the sweep is taken in bulk, so a
   * fetch costs a handful of API calls however many changes it carries; in
   * return each change's comments may be capped, which `commentsTruncated`
   * reports.
   */
  fetchChanges(since: ForgeCursor | undefined): Promise<ForgeSweep>;

  /** The open change with head `branch`, or undefined if there is none. */
  findChange(branch: ChangeName): Promise<ForgeChange | undefined>;

  getChange(id: ForgeChangeId): Promise<ForgeChange>;

  /** Open a change merging `head` into `parent`, ready for review. `head` must already be pushed. */
  createChange(head: ChangeName, parent: ChangeName, title: string): Promise<ForgeChange>;

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
/**
 * The id an import mints, hashed from the forge change's own identity:
 * clones importing the same forge change concurrently converge on one log
 * ref instead of minting duplicate changes.
 */
async function importedChangeId(locator: ForgeLocator, id: ForgeChangeId): Promise<ChangeId> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${locator}#${id}`));
  return parseChangeId(
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32),
  );
}

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
 * already record it: however the merge is observed, it means the change
 * landed. A single-parent landing commit (a squash or rebase merge) descends
 * from no reviewed history, so the entry records the head that merged as the
 * change's tip.
 *
 * TODO: a merge observed here bypassed `recordLand`, so nothing settled the
 * landed diff's review — it reads as unreviewed work in both the parent and
 * the landed change until someone reviews it. The observer should settle it
 * the way the land op does, evaluated as of the observation; writing the
 * land entry is the guard that keeps racing observers from each settling.
 * The land's other conclusions are likewise still the user's: children are
 * not walked to the parent, and a permanent change's branch stays put until
 * its next rebase. Reaching the merges made while untracked also means
 * fetch reading closed forge changes, which it skips today.
 */
export function observedLand(
  now: () => TimestampMs,
  user: UserName,
  forge: ForgeLocator,
  forgeChange: ForgeChange,
  entries: readonly LogEntry[],
): LogEntry | undefined {
  if (forgeChange.state !== "merged" || forgeChange.merge === undefined) {
    return undefined;
  }
  // Recorded already — locally, or by an earlier observation — means this
  // merge is accounted for; a land entry with another merge is an earlier
  // cycle's, and this one still mirrors in.
  const merge = forgeChange.merge.commit;
  if (entries.some(({ action }) => action.kind === "land" && action.merge === merge)) {
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
  change: Change,
): LogEntry[] {
  const entries = change.entries;
  const name = currentName(change.id, entries);
  const adoption: LogEntry[] = [
    {
      timestamp: now(),
      user,
      source: { forge: locator },
      action: { kind: "set-forge", forge: locator, id: forgeChange.id },
    },
  ];
  if (forgeChange.parent === currentParent(name, entries)) {
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
  change: Change,
): Promise<ForgeChange | undefined> {
  const recorded = currentForgeChange(change.entries);
  if (recorded !== undefined && recorded.forge === forge.locator) {
    return forge.getChange(recorded.id);
  }
  const found = await forge.findChange(currentName(change.id, change.entries));
  if (found !== undefined) {
    await backend.appendLog(change.id, adoptionEntries(now, user, forge.locator, found, change));
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
  change: Change,
  forgeChange: ForgeChange,
  method: LandMethod,
  overrides: LandOverrides,
): Promise<Revision> {
  const entries = change.entries;
  const name = currentName(change.id, entries);
  if (forgeChange.state === "merged") {
    throw new UserError(`${forge.locator}#${forgeChange.id} was already merged; run \`cab sync\` to record the land`);
  }
  if (forgeChange.state === "closed") {
    throw new UserError(
      `${forge.locator}#${forgeChange.id} is closed; reopen it, or land locally (cab config land-via local)`,
    );
  }
  if (forgeChange.head !== name) {
    throw new UserError(
      `${forge.locator}#${forgeChange.id} merges ${JSON.stringify(forgeChange.head)}, not this change`,
    );
  }
  const parent = currentParent(name, entries);
  if (forgeChange.parent !== parent) {
    throw new UserError(
      `${forge.locator}#${forgeChange.id} merges into ${JSON.stringify(forgeChange.parent)}, ` +
        `not ${JSON.stringify(parent)}; run \`cab sync\` to retarget it`,
    );
  }
  await backend.fetch(parent);
  const prepared = await prepareLand(backend, change, overrides);
  if (forgeChange.tip !== prepared.tip) {
    throw new UserError(
      `${forge.locator}#${forgeChange.id} is not at ${JSON.stringify(name)}'s tip; run \`cab sync\` first`,
    );
  }
  const merge = await forge.landChange(
    forgeChange.id,
    method,
    prepared.tip,
    landTitle(name),
    landTrailer(name),
  );
  // Fetch before recording: the settling entries read the merge commit, which
  // arrives with the parent.
  await backend.fetch(parent);
  await recordLand(backend, now, change, prepared, merge);
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
  const all = await allChanges(backend);
  const retargeted: { change: ChangeName; forge: ForgeLocator; id: ForgeChangeId }[] = [];
  for (const name of children) {
    const child = requireNamed(all, name);
    const tracked = currentForgeChange(child.entries);
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
    await backend.appendLog(child.id, [
      { timestamp: now(), user, source: { forge: forge.locator }, action: { kind: "set-parent", parent: onto } },
    ]);
    retargeted.push({ change: name, forge: forge.locator, id: tracked.id });
  }
  return retargeted;
}

/**
 * Land `change` where `config` says: on the forge — merging its forge change —
 * when `landVia` is "forge", or "auto" with a forge change recorded in the
 * log; locally otherwise. `openForge` is consulted only for a forge land, so
 * local lands need no forge at all. An ordinary change archives with the
 * land, so its children are then reparented onto its parent, where their
 * code now lives — a forge land also retargets their forge changes to
 * follow; a permanent change stays their parent, live at the landing commit.
 */
export async function landAsConfigured(
  backend: Backend,
  now: () => TimestampMs,
  openForge: () => Promise<Forge>,
  config: Config,
  change: Change,
  overrides: LandOverrides,
): Promise<LandOutcome> {
  const entries = change.entries;
  const name = currentName(change.id, entries);
  const viaForge =
    config.landVia === "forge" || (config.landVia === "auto" && currentForgeChange(entries) !== undefined);
  let merged: LandOutcome["merged"];
  let publication: LandOutcome["publication"];
  let forge: Forge | undefined;
  if (!viaForge) {
    publication = await landChange(backend, now, change, config.landMethod, overrides);
  } else {
    forge = await openForge();
    const forgeChange = await syncedForgeChange(backend, now, await backend.currentUser(), forge, change);
    if (forgeChange === undefined) {
      throw new UserError(
        `no forge change for ${JSON.stringify(name)} on ${forge.locator}; run \`cab sync\` first`,
      );
    }
    await landOnForge(backend, now, forge, change, forgeChange, config.landMethod, overrides);
    merged = { forge: forge.locator, id: forgeChange.id };
  }
  if (currentPermanent(entries)) {
    return { merged, reparented: undefined, publication };
  }
  const onto = currentParent(name, entries);
  const children = await reparentLandedChildren(backend, now, name, onto);
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
  | { readonly kind: "pruned"; readonly id: ForgeChangeId; readonly change: ChangeName }
  | ({ readonly kind: "published"; readonly change: ChangeName } & PublishResult)
  | { readonly kind: "pushed"; readonly change: ChangeName }
  | { readonly kind: "joined"; readonly change: ChangeName };

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
  change: Change,
  forgeChange: ForgeChange,
  comments?: readonly ForgeComment[],
): Promise<AbsorbResult> {
  const entries = change.entries;
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
  // A closed forge change mirrors in as archived, a reopened one as live. A
  // merged one has landed: an ordinary change archives with the land it
  // mirrors in, as the land op would have; a permanent one lives on.
  const archived =
    forgeChange.state === "merged"
      ? landing !== undefined && !currentPermanent(entries)
        ? [archivedObservation(now, user, forge.locator, true)]
        : []
      : planArchivedPull(now, user, forge.locator, entries, forgeChange.state === "closed");
  additions.push(...archived);
  if (additions.length > 0) {
    await backend.appendLog(change.id, additions);
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
 * How long since sweeps may run before an open sweep re-reads everything
 * still open. Forges move some state without touching a change's update
 * stamp — a note edit, a refused reviewer withdrawal — so since sweeps
 * alone drift.
 */
const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * The shared forge sweep record: one `<fact> <locator> <ms>` line per fact —
 * "cursor", how far absorption has reached on the forge's clock, and
 * "reconciled", when the open set was last swept whole. Shared because
 * absorption lands in the logs before the record advances, so any clone
 * that has unioned origin's logs may resume where the record says. Facts
 * join by max; an unreadable line reads as absent, so a corrupted copy
 * costs a resweep and heals on the next publish.
 */
function parseSweepRecord(raw: string | undefined): Map<string, number> {
  const record = new Map<string, number>();
  for (const line of raw?.split("\n") ?? []) {
    const parts = line.split(" ");
    const ms = Number(parts[2]);
    if (parts.length === 3 && parts[0] !== "" && parts[1] !== "" && Number.isFinite(ms)) {
      const key = `${parts[0]} ${parts[1]}`;
      record.set(key, Math.max(ms, record.get(key) ?? 0));
    }
  }
  return record;
}

function formatSweepRecord(record: ReadonlyMap<string, number>): string {
  return [...record]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, ms]) => `${key} ${ms}\n`)
    .join("");
}

/**
 * Whether `entries` carry intent the forge has not been shown: an attribute
 * whose current value differs from its last forge observation. Comments are
 * invisible here — pushed ones leave no local trace — and converge through
 * write-through, sync, and the change's own appearances in the sweep.
 */
function unpublishedIntent(forge: ForgeLocator, change: ChangeName, entries: readonly LogEntry[]): boolean {
  const reviewers = currentReviewers(entries);
  const observedReviewers = observedForgeReviewers(entries, forge);
  if (reviewers.length !== observedReviewers.size || reviewers.some((user) => !observedReviewers.has(user))) {
    return true;
  }
  const observedReviewing = observedForgeReviewing(entries, forge);
  if (observedReviewing !== undefined && (currentReviewing(entries) === "none") !== (observedReviewing === "none")) {
    return true;
  }
  const observedArchived = observedForgeArchived(entries, forge);
  if (observedArchived !== undefined && currentArchived(entries) !== observedArchived) {
    return true;
  }
  const observedParent = observedForgeParent(entries, forge);
  return observedParent !== undefined && currentParent(change, entries) !== observedParent;
}

/**
 * Fetch everything remote, forge included: refresh origin's copies,
 * fast-forward branches whose moves lose nothing (as `advanceBranches`),
 * merge every change's log with origin's, then absorb the forge's sweep —
 * import each open forge change that has no log yet as a change to review
 * (owned by its author, parented on its target branch, its discussion
 * imported), refresh every tracked change the sweep touched (as
 * `absorbForgeChange`), mirror closed forge changes in as archived, and
 * prune changes whose forge change closed before anyone engaged with them.
 * Sweeps resume from a per-repository cursor when the adapter mints one, so
 * a quiet forge costs one sweep that carries nothing. Returns what the
 * sweep covered and how many changes it carried.
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
  opts: { readonly full?: boolean } = {},
): Promise<{ readonly coverage: "open" | "since"; readonly swept: number }> {
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
  const tracked = await allChanges(backend);
  const trackedNames = tracked.map((change) => currentName(change.id, change.entries));
  for (const change of await backend.joinBranches(trackedNames)) {
    onEvent({ kind: "joined", change });
  }
  for (const change of await pushAdvances(backend, trackedNames)) {
    onEvent({ kind: "pushed", change });
  }
  const existing = new Set(trackedNames);

  const record = parseSweepRecord(await backend.forgeSweepState());
  // Clamped so a peer's fast clock cannot suppress resweeps for long.
  const lastOpen = Math.min(record.get(`reconciled ${forge.locator}`) ?? Number.NEGATIVE_INFINITY, now());
  const resweep = opts.full === true || lastOpen + RECONCILE_INTERVAL_MS <= now();
  const shared = record.get(`cursor ${forge.locator}`);
  const sweep = await forge.fetchChanges(resweep || shared === undefined ? undefined : forgeCursor(String(shared)));
  // Open changes keyed by head — closed ones neither import nor adopt — with
  // heads sharing a branch collapsed to the lowest id, so every machine
  // imports the same change for a branch with several open forge changes.
  const byHead = new Map<ChangeName, SweptChange>();
  for (const candidate of sweep.changes) {
    const prev = byHead.get(candidate.change.head);
    if (candidate.change.state === "open" && (prev === undefined || candidate.change.id < prev.change.id)) {
      byHead.set(candidate.change.head, candidate);
    }
  }
  const byId = new Map(sweep.changes.map((candidate) => [candidate.change.id, candidate]));

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
      { timestamp: now(), user, source, action: { kind: "set-name", name: forgeChange.head } },
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
    await backend.appendLog(await importedChangeId(forge.locator, forgeChange.id), additions);
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
  type PruneCandidate = { readonly change: Change; readonly id: ForgeChangeId; readonly archived: boolean };
  const refreshed = await Promise.all(
    tracked.map(async (change): Promise<PruneCandidate | undefined> => {
      const entries = change.entries;
      const name = currentName(change.id, entries);
      // A finished change converged when its land archived it; one that
      // landed but lives on — permanent structure — keeps syncing.
      if (finished(entries)) {
        return undefined;
      }
      const recorded = currentForgeChange(entries);
      let bulk: SweptChange | undefined;
      let forgeChange: ForgeChange | undefined;
      if (recorded !== undefined) {
        if (recorded.forge !== forge.locator) {
          return undefined;
        }
        bulk = byId.get(recorded.id);
        if (
          bulk === undefined &&
          sweep.coverage === "since" &&
          !unpublishedIntent(forge.locator, name, entries)
        ) {
          // Absent from a since sweep with nothing pending: converged.
          return undefined;
        }
        // Fetched live when the sweep did not carry it: an open-sweep absence
        // merged or closed, and a since-sweep absence has intent to publish.
        forgeChange = bulk?.change ?? (await forge.getChange(recorded.id));
      } else {
        // An untracked branch's open forge change is adopted without asking
        // the forge change by change.
        bulk = byHead.get(name);
        if (bulk !== undefined) {
          forgeChange = bulk.change;
          await backend.appendLog(change.id, adoptionEntries(now, user, forge.locator, forgeChange, change));
        } else if (
          currentArchived(entries) ||
          currentReviewing(entries) === "none" ||
          (await backend.originTip(name)) === undefined
        ) {
          return undefined;
        } else {
          // A forge change is due — reviewing left none while the forge was
          // unreachable, say — so the sweep finishes the write-through's job.
          forgeChange = await syncedForgeChange(backend, now, user, forge, change);
        }
      }
      if (forgeChange?.state === "closed") {
        // Mirror the close in as archived before judging engagement: the
        // observation carries a source, so a pure import stays prunable.
        const mirror = planArchivedPull(now, user, forge.locator, entries, true);
        if (mirror.length > 0) {
          await backend.appendLog(change.id, mirror);
        }
        return { change, id: forgeChange.id, archived: mirror.length > 0 };
      }
      const comments = bulk !== undefined && !bulk.commentsTruncated ? bulk.comments : undefined;
      if (forgeChange !== undefined) {
        const absorbed = await absorbForgeChange(backend, now, user, forge, change, forgeChange, comments);
        onEvent({ kind: "absorbed", id: forgeChange.id, change: name, ...absorbed });
      }
      const published = await publishForgeChange(
        backend,
        now,
        forge,
        { ...change, entries: await backend.readLog(change.id) },
        forgeChange,
        comments,
      );
      if (
        published !== undefined &&
        (published.opened ||
          published.reviewers > 0 ||
          published.comments > 0 ||
          published.draft !== undefined ||
          published.state !== undefined ||
          published.archived !== undefined)
      ) {
        onEvent({ kind: "published", change: name, ...published });
      }
      return undefined;
    }),
  );
  const pruneCandidates = refreshed.filter((candidate): candidate is PruneCandidate => candidate !== undefined);

  // Publish what this fetch imported and appended.
  await backend.syncLogs();

  // Advanced only now, after the logs published: a crash beforehand leaves
  // the old record, and the next sweep re-reads an overlap absorption
  // tolerates. Whoever advances it first spares every other clone the same
  // sweep.
  const advance = (key: string, ms: number) => {
    const prior = record.get(key) ?? 0;
    record.set(key, Math.max(ms, prior));
    return ms > prior;
  };
  let advanced = false;
  const minted = Number(sweep.cursor);
  if (sweep.cursor !== undefined && Number.isFinite(minted)) {
    advanced = advance(`cursor ${forge.locator}`, minted) || advanced;
  }
  if (sweep.coverage === "open") {
    advanced = advance(`reconciled ${forge.locator}`, now()) || advanced;
  }
  if (advanced) {
    await backend.publishForgeSweepState(formatSweepRecord(record));
  }

  // Prune closed changes nobody engaged with, judged after the closing sync
  // so engagement published from another machine counts. An engaged change
  // keeps its log; the close it mirrored in as archived is reported instead.
  for (const { change, id, archived } of pruneCandidates) {
    const name = currentName(change.id, change.entries);
    if (pureImport(await backend.readLog(change.id))) {
      await backend.deleteLog(change.id);
      onEvent({ kind: "pruned", id, change: name });
    } else if (archived) {
      onEvent({ kind: "archived", id, change: name });
    }
  }

  return { coverage: sweep.coverage, swept: sweep.changes.length };
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
  change: Change,
  found: ForgeChange | undefined,
  comments?: readonly ForgeComment[],
): Promise<PublishResult | undefined> {
  const entries = change.entries;
  const name = currentName(change.id, entries);
  const parent = currentParent(name, entries);
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
    // The forge change is the change's attention artifact: none exists until
    // reviewing leaves none and the head reaches origin, and archiving asks
    // for no new one. The change replicates regardless — its branch and log
    // are already at origin.
    const head = await backend.originTip(name);
    if (currentArchived(entries) || currentReviewing(entries) === "none" || head === undefined) {
      return undefined;
    }
    // Forges refuse a change whose head adds no commits over its parent —
    // judged against the forge's own copies, which are origin's — so opening
    // waits until it does.
    const parentTip = await backend.originTip(parent);
    if (parentTip !== undefined && (await backend.isAncestor(head, parentTip))) {
      return undefined;
    }
    forgeChange = await forge.createChange(name, parent, name);
    await backend.appendLog(change.id, [
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
    const current = await backend.readLog(change.id);
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
      await backend.appendLog(change.id, additions);
    }
  }
  const open = (state ?? forgeChange.state) === "open";
  if (open && forgeChange.parent !== parent) {
    await forge.setParent(forgeChange.id, parent);
    await backend.appendLog(change.id, [observation()]);
  }
  let reviewers = 0;
  let draft: boolean | undefined;
  if (open) {
    // Absorb forge-side reviewer and draft changes first, so what remains
    // between the log and the forge is exactly this side's intent.
    const current = await backend.readLog(change.id);
    const mirrored = planReviewerPull(now, user, forge.locator, current, forgeChange.reviewers);
    const plan = planReviewerPush(now, user, forge.locator, [...current, ...mirrored], forgeChange.reviewers);
    reviewers = plan.add.length + plan.remove.length;
    let readBack: readonly LogEntry[] = [];
    if (reviewers > 0) {
      await forge.setReviewers(forgeChange.id, plan.add, plan.remove);
      // Best effort settles here: the observations above record what was
      // asked, and a fresh reading mirrors back whatever the forge refused —
      // a reviewer who has reviewed cannot be withdrawn — rather than leaving
      // the difference to a sweep that may never revisit an untouched change.
      const fresh = await forge.getChange(forgeChange.id);
      readBack = planReviewerPull(
        now,
        user,
        forge.locator,
        [...current, ...mirrored, ...plan.observations],
        fresh.reviewers,
      );
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
    const additions = [
      ...mirrored,
      ...plan.observations,
      ...readBack,
      ...reviewingMirror,
      ...reviewingPlan.observations,
    ];
    if (additions.length > 0) {
      await backend.appendLog(change.id, additions);
    }
  }
  const bodies = await planPush(entries, comments ?? (await forge.listComments(forgeChange.id)), user);
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

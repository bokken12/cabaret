import {
  assertChangeExists,
  assertNotArchived,
  assertNotLanded,
  type Backend,
  type ChangeName,
  changeBase,
  changeDiff,
  conflictsBetween,
  currentArchived,
  currentBase,
  currentOwner,
  currentParent,
  currentReviewers,
  currentReviewing,
  diffBetween,
  ensureBranch,
  type FilePath,
  freshestReading,
  type Land,
  type LogEntry,
  landedRevision,
  landMessage,
  type Reviewing,
  type Revision,
  requireTip,
  type TimestampMs,
  type UserName,
  widerReviewing,
} from "./backend.js";
import type { LandMethod } from "./config.js";
import { isConnectivityError } from "./connectivity.js";
import { UserError } from "./error.js";
import { assertObligationsSatisfied, isSatisfied, obligationStatuses, UnreviewedParentError } from "./obligations.js";
import { currentSelf, isSelf } from "./self.js";
import { reviewRounds } from "./summary.js";

/**
 * Create a change, initializing its log with a parent, a base, and an owner
 * (the current user unless `owner` says otherwise). A branch that does not
 * exist yet is created at the parent's tip; an existing branch is adopted
 * with the last revision shared with the parent as its base. Parent and
 * adopted branch alike read freshest — the descendant-most of the local tip
 * and origin's last-fetched copy — and diverged readings fail until synced.
 * The change must not already exist. Review starts with nobody asked — the
 * change is a draft until widened — though the owner may record self-review
 * at any stage.
 */
export async function createChange(
  backend: Backend,
  now: () => TimestampMs,
  change: ChangeName,
  parent: ChangeName,
  owner?: UserName,
): Promise<void> {
  if (change === parent) {
    throw new UserError(`change cannot be its own parent: ${JSON.stringify(change)}`);
  }
  if ((await backend.readLog(change)).length > 0) {
    throw new UserError(`change already exists: ${JSON.stringify(change)}`);
  }
  const parentReading = await freshestReading(backend, parent);
  if (parentReading.kind === "none") {
    throw new UserError(`parent branch does not exist: ${JSON.stringify(parent)}`);
  }
  // Not a `DivergedParentError`: frontends attach rebase's override remedy
  // to that class, and create offers no override — sync is the way forward.
  if (parentReading.kind === "diverged") {
    throw new UserError(`local ${JSON.stringify(parent)} has diverged from origin's copy; sync it first`);
  }
  const parentTip = parentReading.tip;
  // Resolve the identity before mutating any ref so a missing identity
  // fails without leaving a branch behind.
  const user = await backend.currentUser();
  const existing = await freshestReading(backend, change);
  if (existing.kind === "diverged") {
    throw new UserError(`local ${JSON.stringify(change)} has diverged from origin's copy; sync it first`);
  }
  // A fresh branch is created at the parent's tip, which is therefore its
  // base; an adopted branch is based where it last shared with the parent.
  // One adopted from origin's copy alone stays unmaterialized, like an
  // imported change: the branch appears on engagement.
  let base: Revision;
  if (existing.kind === "none") {
    await backend.create(change, parentTip);
    base = parentTip;
  } else {
    base = await backend.mergeBase(parentTip, existing.tip);
  }
  await backend.appendLog(change, [
    { timestamp: now(), user, action: { kind: "set-parent", parent } },
    { timestamp: now(), user, action: { kind: "set-base", base } },
    { timestamp: now(), user, action: { kind: "set-owner", owner: owner ?? user } },
    { timestamp: now(), user, action: { kind: "set-reviewing", reviewing: "none" } },
  ]);
}

/** Record who is asked to review `change`. A landed change is frozen. */
export async function setReviewing(
  backend: Backend,
  now: () => TimestampMs,
  change: ChangeName,
  entries: readonly LogEntry[],
  reviewing: Reviewing,
): Promise<void> {
  assertChangeExists(change, entries);
  assertNotLanded(change, entries);
  await backend.appendLog(change, [
    { timestamp: now(), user: await backend.currentUser(), action: { kind: "set-reviewing", reviewing } },
  ]);
}

/**
 * Archive `change` — set it aside as not landing — or bring it back. Nothing
 * is deleted: the branch and log stay, todos just stop asking after the
 * change and `land` refuses it until unarchived. A landed change is frozen,
 * so it can move neither way.
 */
export async function setArchived(
  backend: Backend,
  now: () => TimestampMs,
  change: ChangeName,
  entries: readonly LogEntry[],
  archived: boolean,
): Promise<void> {
  assertChangeExists(change, entries);
  assertNotLanded(change, entries);
  await backend.appendLog(change, [
    { timestamp: now(), user: await backend.currentUser(), action: { kind: "set-archived", archived } },
  ]);
}

/**
 * Widen `change`'s reviewing set: one step, and past any step that would ask
 * nothing of anyone. A level asks something when a user it newly adds still
 * has review left — the owner at "owner", the reviewers at "reviewers" — so
 * an owner who already read the whole diff is skipped, as are reviewers who
 * have (or a change with none), landing on the first level with real review
 * to do, or on "everyone", where the obligations files decide. Returns the
 * step taken.
 */
export async function widenReviewing(
  backend: Backend,
  now: () => TimestampMs,
  change: ChangeName,
  entries: readonly LogEntry[],
): Promise<{ readonly from: Reviewing; readonly to: Reviewing }> {
  assertChangeExists(change, entries);
  assertNotLanded(change, entries);
  const from = currentReviewing(entries);
  let to = widerReviewing(from);
  if (to === undefined) {
    throw new UserError(`everyone is already reviewing ${JSON.stringify(change)}`);
  }
  const diff = await changeDiff(backend, change, entries);
  const owes = async (user: UserName): Promise<boolean> =>
    (await reviewRounds(backend, entries, user, diff)).length > 0;
  const owner = currentOwner(change, entries);
  while (to !== "everyone") {
    const added = to === "owner" ? [owner] : currentReviewers(entries).filter((reviewer) => reviewer !== owner);
    let asks = false;
    for (const user of added) {
      if (await owes(user)) {
        asks = true;
        break;
      }
    }
    if (asks) {
      break;
    }
    const wider = widerReviewing(to);
    if (wider === undefined) {
      throw new Error("widening past everyone");
    }
    to = wider;
  }
  await setReviewing(backend, now, change, entries, to);
  return { from, to };
}

/** One change of a resolved chain, with the log that placed it there. */
export interface ChainLink {
  readonly change: ChangeName;
  readonly entries: readonly LogEntry[];
}

/**
 * The changes of `ancestor..descendant`: those strictly after `ancestor` on
 * `descendant`'s parent chain, ancestormost first. `ancestor` itself need not
 * be a change — a range bottoming out at trunk names the whole stack — but
 * every change after it must be, since only changes record parents.
 */
export async function resolveRange(
  backend: Backend,
  ancestor: ChangeName,
  descendant: ChangeName,
): Promise<readonly ChainLink[]> {
  const chain: ChainLink[] = [];
  const seen = new Set<ChangeName>();
  let cursor = descendant;
  while (cursor !== ancestor) {
    if (seen.has(cursor)) {
      throw new UserError(`parent chain from ${JSON.stringify(descendant)} loops at ${JSON.stringify(cursor)}`);
    }
    seen.add(cursor);
    const entries = await backend.readLog(cursor);
    if (entries.length === 0) {
      throw new UserError(
        `${JSON.stringify(ancestor)} is not an ancestor of ${JSON.stringify(descendant)}: ` +
          `the parent chain stops at ${JSON.stringify(cursor)}, which is not a change`,
      );
    }
    chain.push({ change: cursor, entries });
    cursor = currentParent(cursor, entries);
  }
  return chain.reverse();
}

/**
 * The chain links for `changes` in the order given, ancestormost first,
 * verifying they form a stack: each change after the first must have its
 * predecessor as its current parent.
 */
export async function resolveChain(backend: Backend, changes: readonly ChangeName[]): Promise<readonly ChainLink[]> {
  const chain: ChainLink[] = [];
  for (const change of changes) {
    const entries = await backend.readLog(change);
    assertChangeExists(change, entries);
    const previous = chain.at(-1);
    if (previous !== undefined) {
      const parent = currentParent(change, entries);
      if (parent !== previous.change) {
        throw new UserError(
          `not a stack: ${JSON.stringify(change)}'s parent is ` +
            `${JSON.stringify(parent)}, not ${JSON.stringify(previous.change)}`,
        );
      }
    }
    chain.push({ change, entries });
  }
  return chain;
}

/**
 * The ownership check failed: `change` belongs to someone else. The message
 * states only the fact; each frontend attaches its own override remedy — a
 * flag, a confirmation dialog — before showing it.
 */
export class NotOwnerError extends UserError {
  constructor(
    readonly change: ChangeName,
    readonly owner: UserName,
    readonly user: UserName,
  ) {
    super(`${JSON.stringify(change)} is owned by ${JSON.stringify(owner)}, not ${JSON.stringify(user)}`);
  }
}

/**
 * The parent's readings have diverged: local and origin's last-fetched copy
 * each carry work the other lacks, so no freshest reading exists and the
 * user must join them (syncing the parent does, when it is a change). As
 * with `NotOwnerError`, the message states only the fact; each frontend
 * attaches its own override remedy before showing it.
 */
export class DivergedParentError extends UserError {
  constructor(readonly parent: ChangeName) {
    super(`local ${JSON.stringify(parent)} has diverged from origin's copy; sync it first`);
  }
}

/**
 * Fail unless the current user owns `change` — as themselves or as one of
 * their aliases; `override` skips the check. A log with no owner is malformed
 * and fails regardless of the override: the override excuses not being the
 * owner, not a broken log.
 */
export async function requireOwner(
  backend: Backend,
  change: ChangeName,
  entries: readonly LogEntry[],
  override: boolean,
): Promise<void> {
  const owner = currentOwner(change, entries);
  if (override) {
    return;
  }
  const self = await currentSelf(backend);
  if (!isSelf(self, owner)) {
    throw new NotOwnerError(change, owner, self.user);
  }
}

/** Fail if `target` still carries conflict markers in `conflicts`. */
export function assertNoConflict(target: ChangeName, conflicts: readonly FilePath[]): void {
  if (conflicts.length > 0) {
    throw new UserError(
      `${JSON.stringify(target)} has unresolved conflicts in ${conflicts.join(", ")}; fix the markers and amend`,
    );
  }
}

/** The rebase checks the user may explicitly override. */
export interface RebaseOverrides {
  /** Rebase a change the current user does not own. */
  readonly notOwner: boolean;
  /** Rebase onto the parent's local reading even though origin's has diverged from it. */
  readonly parentDiverged: boolean;
}

/**
 * Move `target` onto its parent's tip by merging the tip into the change,
 * then record the new base in the log. The tip is the parent's freshest
 * reading — the descendant-most of local and last-fetched origin, since the
 * merge moves nothing of the parent's — and diverged readings fail until
 * synced, the override proceeding with the local one. A conflicting merge
 * still commits, markers in place, for the owner to fix in their own time;
 * the move is complete, so the base is pinned all the same. A change whose
 * files already carry markers must be fixed before it moves again — merging
 * onto them would bake them in as resolved content.
 *
 * TODO: offer a replay-style rebase (`git rebase --onto`) as an alternative
 * once conflicts have a story that never leaves a change mid-operation.
 */
export async function rebaseChange(
  backend: Backend,
  now: () => TimestampMs,
  target: ChangeName,
  entries: readonly LogEntry[],
  overrides: RebaseOverrides,
): Promise<void> {
  assertNotLanded(target, entries);
  await requireOwner(backend, target, entries, overrides.notOwner);
  const parent = currentParent(target, entries);
  const reading = await freshestReading(backend, parent);
  if (reading.kind === "none") {
    throw new UserError(`parent branch does not exist: ${JSON.stringify(parent)}`);
  }
  if (reading.kind === "diverged" && !overrides.parentDiverged) {
    throw new DivergedParentError(parent);
  }
  const onto = reading.kind === "fresh" ? reading.tip : reading.local;
  const base = await changeBase(backend, target, entries);
  // The merge moves the target's branch, so one held only at origin materializes.
  const tip = await ensureBranch(backend, target);
  assertNoConflict(target, await conflictsBetween(backend, base, tip));
  // A tip the base already reaches — the parent trailing where the change
  // was built — offers nothing to move; merging it would reverse-diff the
  // newer history, and pinning to it would slide the base backwards and
  // pull the parent's commits into the diff.
  if (onto !== base && (await backend.isAncestor(onto, base))) {
    return;
  }
  // When the change already sits on the parent's tip (base === onto), whether
  // because it was just rebased or an out-of-band rebase put it there, there
  // is no code to move.
  let conflicts: readonly FilePath[] = [];
  if (base !== onto) {
    conflicts = await backend.mergeOnto(target, base, onto, `Merge branch '${parent}' into ${target}`);
  }
  // Pin the base to the parent's tip so a later parent rewrite cannot slide
  // it back to an ancestor and pull the parent's commits into the diff.
  if (currentBase(target, entries) !== onto) {
    await backend.appendLog(target, [
      { timestamp: now(), user: await backend.currentUser(), action: { kind: "set-base", base: onto } },
    ]);
  }
  if (conflicts.length > 0) {
    throw new UserError(
      `merging ${JSON.stringify(parent)} into ${JSON.stringify(target)} ` +
        `left conflicts in ${conflicts.join(", ")}; fix the markers and amend`,
    );
  }
}

/**
 * Rebase every change of `chain` onto its parent's tip, ancestormost first so
 * each change's rebase finds its parent already at rest. A landed change is
 * frozen where it landed and is skipped; its descendants still rebase onto
 * its tip. When one change fails — a conflicting merge commits its markers
 * and counts — the rebases before it stand, and rerunning the chain resumes
 * once it is fixed.
 */
export async function rebaseChain(
  backend: Backend,
  now: () => TimestampMs,
  chain: readonly ChainLink[],
  overrides: RebaseOverrides,
): Promise<void> {
  for (const { change, entries } of chain) {
    if (landedRevision(entries) !== undefined) {
      continue;
    }
    await rebaseChange(backend, now, change, entries, overrides);
  }
}

/** A land's endpoints, resolved once its preconditions have been checked. */
export interface PreparedLand {
  readonly parent: ChangeName;
  readonly base: Revision;
  /** The parent's tip the land merges onto: `base` itself unless the parent moved on. */
  readonly onto: Revision;
  readonly tip: Revision;
  readonly user: UserName;
}

/** The land checks the user may explicitly override. */
export interface LandOverrides {
  /** Land a change the current user does not own. */
  readonly notOwner: boolean;
  /** Land with review obligations unsatisfied. */
  readonly unreviewed: boolean;
  /** Land into a parent whose own review obligations are unsatisfied. */
  readonly parentUnreviewed: boolean;
}

/**
 * Check that `target` may land now — unlanded, owned by the current user,
 * with an unlanded parent, with commits of its own, free of unresolved
 * conflicts, merging cleanly onto the parent's tip when the parent moved on,
 * and with its review obligations satisfied — and resolve the endpoints the
 * landing writes. `overrides` skips the checks it names.
 */
export async function prepareLand(
  backend: Backend,
  target: ChangeName,
  entries: readonly LogEntry[],
  overrides: LandOverrides,
): Promise<PreparedLand> {
  assertNotLanded(target, entries);
  assertNotArchived(target, entries);
  await requireOwner(backend, target, entries, overrides.notOwner);
  const parent = currentParent(target, entries);
  // A parent that is itself a landed change is frozen too: landing into it
  // would grow the code its own land froze. One archived is set aside, so
  // landing into it would bury the work. A parent that is not a change (an
  // empty log) can be neither.
  const parentEntries = await backend.readLog(parent);
  assertNotLanded(parent, parentEntries);
  assertNotArchived(parent, parentEntries);
  // The land stands on the parent's freshest reading, like a rebase, and
  // diverged readings fail until synced — a land onto the local reading
  // alone could never publish.
  const parentReading = await freshestReading(backend, parent);
  if (parentReading.kind === "none") {
    throw new UserError(`parent branch does not exist: ${JSON.stringify(parent)}`);
  }
  if (parentReading.kind === "diverged") {
    throw new UserError(`local ${JSON.stringify(parent)} has diverged from origin's copy; sync it first`);
  }
  const onto = parentReading.tip;
  const base = await changeBase(backend, target, entries);
  const tip = await requireTip(backend, target);
  if (tip === base) {
    throw new UserError(`nothing to land: ${JSON.stringify(target)} has no commits of its own`);
  }
  assertNoConflict(target, await conflictsBetween(backend, base, tip));
  if (base !== onto) {
    const conflicts = await backend.mergeConflicts(base, tip, onto);
    if (conflicts.length > 0) {
      throw new UserError(
        `${JSON.stringify(target)} conflicts with the tip of ${JSON.stringify(parent)} ` +
          `in ${conflicts.join(", ")}; run \`cabaret rebase\` first`,
      );
    }
  }
  if (!overrides.unreviewed) {
    const diff = await diffBetween(backend, base, tip);
    await assertObligationsSatisfied(backend, entries, currentOwner(target, entries), diff);
  }
  // A trunk parent has no log and owes nothing. The parent's diff is
  // measured to `onto`, the freshest reading the land merges onto.
  if (!overrides.parentUnreviewed && parentEntries.length > 0) {
    const parentDiff = await diffBetween(backend, await changeBase(backend, parent, parentEntries), onto);
    const statuses = await obligationStatuses(backend, parentEntries, currentOwner(parent, parentEntries), parentDiff);
    const unsatisfied = statuses.filter((status) => !isSatisfied(status));
    if (unsatisfied.length > 0) {
      throw new UnreviewedParentError(parent, unsatisfied);
    }
  }
  // Resolve the identity before any ref moves so a missing identity
  // fails without landing anything.
  const user = await backend.currentUser();
  return { parent, base, onto, tip, user };
}

/**
 * Record `target`'s landing in its log: pin the base — once the parent
 * contains the change, the merge-base with it is useless, so `changeBase`
 * serves the stored base of a landed change forever — and write the land
 * entry. A landing commit that descends from no reviewed history — a squash,
 * or whatever else the forge chose to write — also freezes the tip that
 * landed.
 */
export async function recordLand(
  backend: Backend,
  now: () => TimestampMs,
  target: ChangeName,
  entries: readonly LogEntry[],
  { base, tip, user }: PreparedLand,
  land: Land,
): Promise<void> {
  const pin: LogEntry[] =
    currentBase(target, entries) === base ? [] : [{ timestamp: now(), user, action: { kind: "set-base", base } }];
  await backend.appendLog(target, [
    ...pin,
    { timestamp: now(), user, action: { kind: "land", revision: land.revision, ...(land.parents > 1 ? {} : { tip }) } },
  ]);
}

/** How a local land's parent advance reached origin, if it could. */
export type LandPublication =
  /** The parent branch was pushed: origin carries the land. */
  | "published"
  /** Origin was unreachable; the parent keeps the land locally until pushed. */
  | "origin-unreachable"
  /** Origin never held the parent (or there is no origin): the land is local by nature. */
  | "no-origin";

/**
 * Land `target` into its parent: write it onto the parent branch as a commit
 * marked as landing — a land merge, or one squash commit — record the
 * landing in the log, and push the parent. The land names the parent, so
 * publishing its advance is within the intent asked; what the push could
 * not or need not do comes back as the `LandPublication`. A change no
 * longer sitting on its parent's tip lands all the same when it merges
 * cleanly onto it; rebase first when it conflicts.
 */
export async function landChange(
  backend: Backend,
  now: () => TimestampMs,
  target: ChangeName,
  entries: readonly LogEntry[],
  method: LandMethod,
  overrides: LandOverrides,
): Promise<LandPublication> {
  const prepared = await prepareLand(backend, target, entries, overrides);
  const { parent, base, onto, tip } = prepared;
  // The landing commit goes onto the parent's branch, which the merge
  // advances from `onto` — the freshest reading — so one held only at origin
  // materializes and a merely-behind local copy fast-forwards first. The
  // target's own branch is only read.
  if ((await ensureBranch(backend, parent)) !== onto) {
    await backend.advance(parent, onto);
  }
  const merge =
    method === "merge"
      ? await backend.merge(parent, base, onto, tip, landMessage(target))
      : await backend.squash(parent, base, onto, tip, landMessage(target));
  await recordLand(backend, now, target, entries, prepared, {
    revision: merge,
    parents: method === "merge" ? 2 : 1,
  });
  if ((await backend.originTip(parent)) === undefined) {
    return "no-origin";
  }
  try {
    await backend.push(parent);
  } catch (error) {
    if (!isConnectivityError(error)) {
      throw error;
    }
    return "origin-unreachable";
  }
  return "published";
}

/**
 * Land every change of `chain` with `land`, deepest first: a change lands
 * into its parent, so the parent's own land must wait until it has absorbed
 * everything below. Changes that already landed are skipped, so a rerun after
 * a mid-chain failure resumes where it left off.
 */
export async function landChain(
  backend: Backend,
  chain: readonly ChainLink[],
  land: (change: ChangeName, entries: readonly LogEntry[]) => Promise<void>,
): Promise<void> {
  const first = chain[0];
  if (first === undefined) {
    return;
  }
  // An unlanded change under a landed or archived one can never reach its
  // ancestor: landing below it would only bury work in a jammed chain, so
  // refuse before any merge moves.
  let parent = currentParent(first.change, first.entries);
  let parentEntries = await backend.readLog(parent);
  for (const { change, entries } of chain) {
    const changeLanded = landedRevision(entries) !== undefined;
    if (!changeLanded) {
      if (landedRevision(parentEntries) !== undefined) {
        throw new UserError(
          `${JSON.stringify(change)} would land into ${JSON.stringify(parent)}, which has landed; ` +
            "run `cabaret reparent` first",
        );
      }
      if (currentArchived(parentEntries)) {
        throw new UserError(
          `${JSON.stringify(change)} would land into ${JSON.stringify(parent)}, which is archived; ` +
            "run `cabaret archive --undo` or `cabaret reparent` first",
        );
      }
    }
    parent = change;
    parentEntries = entries;
  }
  for (const { change, entries } of chain.toReversed()) {
    if (landedRevision(entries) !== undefined) {
      continue;
    }
    await land(change, entries);
  }
}

/**
 * Reparent every unlanded child of `landed` onto `parent`, the branch its
 * landing merged into. Landing froze `landed`, so a child pointing at it is
 * stuck; the move follows the code, changes no child's diff — the base stays
 * pinned — and so asks no owner's leave. Returns the children moved, in
 * `listChanges` order.
 */
export async function reparentLandedChildren(
  backend: Backend,
  now: () => TimestampMs,
  landed: ChangeName,
  parent: ChangeName,
): Promise<readonly ChangeName[]> {
  const user = await backend.currentUser();
  const moved: ChangeName[] = [];
  for (const change of await backend.listChanges()) {
    // `parent` itself can be a child of `landed` when a reparent made the two
    // a cycle; moving it would make it its own parent, so leave the cycle for
    // a manual reparent.
    if (change === parent) {
      continue;
    }
    const entries = await backend.readLog(change);
    if (currentParent(change, entries) !== landed || landedRevision(entries) !== undefined) {
      continue;
    }
    await backend.appendLog(change, [{ timestamp: now(), user, action: { kind: "set-parent", parent } }]);
    moved.push(change);
  }
  return moved;
}

/**
 * Update `change`'s parent. This is a metadata/log change only, and does not
 * touch code without a subsequent rebase.
 */
export async function reparentChange(
  backend: Backend,
  now: () => TimestampMs,
  change: ChangeName,
  parent: ChangeName,
  override: boolean,
): Promise<void> {
  if (change === parent) {
    throw new UserError(`change cannot be its own parent: ${JSON.stringify(change)}`);
  }
  const entries = await backend.readLog(change);
  assertNotLanded(change, entries);
  await requireOwner(backend, change, entries, override);
  // The same liveness `create` demands: a parent is a branch — local or
  // origin's fetched copy — change log or not.
  if ((await freshestReading(backend, parent)).kind === "none") {
    throw new UserError(`parent branch does not exist: ${JSON.stringify(parent)}`);
  }
  await backend.appendLog(change, [
    { timestamp: now(), user: await backend.currentUser(), action: { kind: "set-parent", parent } },
  ]);
}

/** Transfer `change` to a new owner. Only the current owner may transfer it. */
export async function transferChange(
  backend: Backend,
  now: () => TimestampMs,
  change: ChangeName,
  owner: UserName,
  override: boolean,
): Promise<void> {
  const entries = await backend.readLog(change);
  assertNotLanded(change, entries);
  await requireOwner(backend, change, entries, override);
  await backend.appendLog(change, [
    { timestamp: now(), user: await backend.currentUser(), action: { kind: "set-owner", owner } },
  ]);
}

/**
 * Rename an unlanded change: move its branch and its log to the new name
 * together, atomically.
 */
// TODO: rename assumes the change lives only in this repository. Once
// changes sync with a remote, a raw ref move races concurrent editors —
// their appends target the old log ref — so a distributed rename likely
// needs to be recorded in the log itself. Children are similarly untouched:
// their `set-parent` entries keep naming the old change until a manual
// `cabaret reparent`.
export async function renameChange(
  backend: Backend,
  from: ChangeName,
  to: ChangeName,
  override: boolean,
): Promise<void> {
  const entries = await backend.readLog(from);
  assertChangeExists(from, entries);
  assertNotLanded(from, entries);
  await requireOwner(backend, from, entries, override);
  if ((await backend.readLog(to)).length > 0) {
    throw new UserError(`change already exists: ${JSON.stringify(to)}`);
  }
  // Origin holding the name counts too: the rename would collide there on push.
  if ((await freshestReading(backend, to)).kind !== "none") {
    throw new UserError(`branch already exists: ${JSON.stringify(to)}`);
  }
  await backend.rename(from, to);
}

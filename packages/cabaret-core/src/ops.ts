import {
  assertChangeExists,
  assertNotLanded,
  type Backend,
  type ChangeName,
  changeBase,
  changeDiff,
  conflictedFiles,
  currentBase,
  currentOwner,
  currentParent,
  currentReviewers,
  currentReviewing,
  diffBetween,
  type FilePath,
  type LandedMerge,
  type LogEntry,
  landedMerge,
  landMessage,
  type Reviewing,
  type Revision,
  requireTip,
  type TimestampMs,
  type UserName,
  widerReviewing,
} from "./backend.js";
import type { LandMethod } from "./config.js";
import { UserError } from "./error.js";
import { assertObligationsSatisfied } from "./obligations.js";
import { currentSelf, isSelf } from "./self.js";
import { reviewRounds } from "./summary.js";

/**
 * Create a change, initializing its log with a parent, a base, and an owner
 * (the current user unless `owner` says otherwise). A branch that does not
 * exist yet is created at the parent's tip; an existing branch is adopted
 * with the last revision shared with the parent as its base. The change must
 * not already exist. Review starts with nobody asked — the change is a draft
 * until widened — though the owner may record self-review at any stage.
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
  const parentTip = await backend.tip(parent);
  if (parentTip === undefined) {
    throw new UserError(`parent branch does not exist: ${JSON.stringify(parent)}`);
  }
  // Resolve the identity before mutating any ref so a missing identity
  // fails without leaving a branch behind.
  const user = await backend.currentUser();
  const existing = await backend.tip(change);
  // A fresh branch is created at the parent's tip, which is therefore its
  // base; an adopted branch is based where it last shared with the parent.
  let base: typeof parentTip;
  if (existing === undefined) {
    await backend.create(change, parentTip);
    base = parentTip;
  } else {
    base = await backend.mergeBase(parentTip, existing);
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
  entries: readonly LogEntry<Revision>[],
  reviewing: Reviewing,
): Promise<void> {
  assertChangeExists(change, entries);
  assertNotLanded(change, entries);
  await backend.appendLog(change, [
    { timestamp: now(), user: await backend.currentUser(), action: { kind: "set-reviewing", reviewing } },
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
  entries: readonly LogEntry<Revision>[],
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
export interface ChainLink<R extends Revision = Revision> {
  readonly change: ChangeName;
  readonly entries: readonly LogEntry<R>[];
}

/**
 * The changes of `ancestor..descendant`: those strictly after `ancestor` on
 * `descendant`'s parent chain, ancestormost first. `ancestor` itself need not
 * be a change — a range bottoming out at trunk names the whole stack — but
 * every change after it must be, since only changes record parents.
 */
export async function resolveRange<R extends Revision>(
  backend: Backend<R>,
  ancestor: ChangeName,
  descendant: ChangeName,
): Promise<readonly ChainLink<R>[]> {
  const chain: ChainLink<R>[] = [];
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
export async function resolveChain<R extends Revision>(
  backend: Backend<R>,
  changes: readonly ChangeName[],
): Promise<readonly ChainLink<R>[]> {
  const chain: ChainLink<R>[] = [];
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
 * Fail unless the current user owns `change` — as themselves or as one of
 * their aliases; `override` skips the check. A log with no owner is malformed
 * and fails regardless of the override: the override excuses not being the
 * owner, not a broken log.
 */
export async function requireOwner(
  backend: Backend,
  change: ChangeName,
  entries: readonly LogEntry<Revision>[],
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

/**
 * Move `target` onto its parent's tip by merging the tip into the change,
 * then record the new base in the log. A conflicting merge still commits,
 * markers in place, for the owner to fix in their own time; the move is
 * complete, so the base is pinned all the same. A change whose files already
 * carry markers must be fixed before it moves again — merging onto them
 * would bake them in as resolved content.
 *
 * TODO: offer a replay-style rebase (`git rebase --onto`) as an alternative
 * once conflicts have a story that never leaves a change mid-operation.
 */
export async function rebaseChange<R extends Revision>(
  backend: Backend<R>,
  now: () => TimestampMs,
  target: ChangeName,
  entries: readonly LogEntry<R>[],
  override: boolean,
): Promise<void> {
  assertNotLanded(target, entries);
  await requireOwner(backend, target, entries, override);
  const parent = currentParent(target, entries);
  const onto = await backend.tip(parent);
  if (onto === undefined) {
    throw new UserError(`parent branch does not exist: ${JSON.stringify(parent)}`);
  }
  const base = await changeBase(backend, target, entries);
  const tip = await requireTip(backend, target);
  assertNoConflict(target, await conflictedFiles(backend, tip, await backend.changedFiles(base, tip)));
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
export async function rebaseChain<R extends Revision>(
  backend: Backend<R>,
  now: () => TimestampMs,
  chain: readonly ChainLink<R>[],
  override: boolean,
): Promise<void> {
  for (const { change, entries } of chain) {
    if (landedMerge(entries) !== undefined) {
      continue;
    }
    await rebaseChange(backend, now, change, entries, override);
  }
}

/** A land's endpoints, resolved once its preconditions have been checked. */
export interface PreparedLand<R extends Revision = Revision> {
  readonly parent: ChangeName;
  readonly base: R;
  /** The parent's tip the land merges onto: `base` itself unless the parent moved on. */
  readonly onto: R;
  readonly tip: R;
  readonly user: UserName;
}

/** The land checks the user may explicitly override. */
export interface LandOverrides {
  /** Land a change the current user does not own. */
  readonly notOwner: boolean;
  /** Land with review obligations unsatisfied. */
  readonly unreviewed: boolean;
}

/**
 * Check that `target` may land now — unlanded, owned by the current user,
 * with an unlanded parent, with commits of its own, free of unresolved
 * conflicts, merging cleanly onto the parent's tip when the parent moved on,
 * and with its review obligations satisfied — and resolve the endpoints the
 * landing writes. `overrides` skips the checks it names.
 */
export async function prepareLand<R extends Revision>(
  backend: Backend<R>,
  target: ChangeName,
  entries: readonly LogEntry<R>[],
  overrides: LandOverrides,
): Promise<PreparedLand<R>> {
  assertNotLanded(target, entries);
  await requireOwner(backend, target, entries, overrides.notOwner);
  const parent = currentParent(target, entries);
  // A parent that is itself a landed change is frozen too: landing into it
  // would grow the code its own land froze. A parent that is not a change
  // (an empty log) cannot have landed.
  assertNotLanded(parent, await backend.readLog(parent));
  const onto = await backend.tip(parent);
  if (onto === undefined) {
    throw new UserError(`parent branch does not exist: ${JSON.stringify(parent)}`);
  }
  const base = await changeBase(backend, target, entries);
  const tip = await requireTip(backend, target);
  if (tip === base) {
    throw new UserError(`nothing to land: ${JSON.stringify(target)} has no commits of its own`);
  }
  assertNoConflict(target, await conflictedFiles(backend, tip, await backend.changedFiles(base, tip)));
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
export async function recordLand<R extends Revision>(
  backend: Backend<R>,
  now: () => TimestampMs,
  target: ChangeName,
  entries: readonly LogEntry<R>[],
  { base, tip, user }: PreparedLand<R>,
  merge: LandedMerge<R>,
): Promise<void> {
  const pin: LogEntry<R>[] =
    currentBase(target, entries) === base ? [] : [{ timestamp: now(), user, action: { kind: "set-base", base } }];
  await backend.appendLog(target, [
    ...pin,
    { timestamp: now(), user, action: { kind: "land", merge: merge.commit, ...(merge.parents > 1 ? {} : { tip }) } },
  ]);
}

/**
 * Land `target` into its parent: write it onto the parent branch as a commit
 * marked as landing — a land merge, or one squash commit — and record the
 * landing in the log. A change no longer sitting on its parent's tip lands
 * all the same when it merges cleanly onto it; rebase first when it
 * conflicts.
 */
export async function landChange<R extends Revision>(
  backend: Backend<R>,
  now: () => TimestampMs,
  target: ChangeName,
  entries: readonly LogEntry<R>[],
  method: LandMethod,
  overrides: LandOverrides,
): Promise<void> {
  const prepared = await prepareLand(backend, target, entries, overrides);
  const { parent, base, onto, tip } = prepared;
  const merge =
    method === "merge"
      ? await backend.merge(parent, base, onto, tip, landMessage(target))
      : await backend.squash(parent, base, onto, tip, landMessage(target));
  await recordLand(backend, now, target, entries, prepared, {
    commit: merge,
    parents: method === "merge" ? 2 : 1,
  });
}

/**
 * Land every change of `chain` with `land`, deepest first: a change lands
 * into its parent, so the parent's own land must wait until it has absorbed
 * everything below. Changes that already landed are skipped, so a rerun after
 * a mid-chain failure resumes where it left off.
 */
export async function landChain<R extends Revision>(
  backend: Backend<R>,
  chain: readonly ChainLink<R>[],
  land: (change: ChangeName, entries: readonly LogEntry<R>[]) => Promise<void>,
): Promise<void> {
  const first = chain[0];
  if (first === undefined) {
    return;
  }
  // An unlanded change under a landed one can never reach its ancestor:
  // landing below it would only bury work in a jammed chain, so refuse
  // before any merge moves.
  let parent = currentParent(first.change, first.entries);
  let parentLanded = landedMerge(await backend.readLog(parent)) !== undefined;
  for (const { change, entries } of chain) {
    const changeLanded = landedMerge(entries) !== undefined;
    if (parentLanded && !changeLanded) {
      throw new UserError(
        `${JSON.stringify(change)} would land into ${JSON.stringify(parent)}, which has landed; ` +
          "run `cabaret reparent` first",
      );
    }
    parent = change;
    parentLanded = changeLanded;
  }
  for (const { change, entries } of chain.toReversed()) {
    if (landedMerge(entries) !== undefined) {
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
    if (currentParent(change, entries) !== landed || landedMerge(entries) !== undefined) {
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
  // The same liveness `create` demands: a parent is a branch, change log or not.
  if ((await backend.tip(parent)) === undefined) {
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
export async function renameChange<R extends Revision, C extends ChangeName>(
  backend: Backend<R, C>,
  from: C,
  to: C,
  override: boolean,
): Promise<void> {
  const entries = await backend.readLog(from);
  assertChangeExists(from, entries);
  assertNotLanded(from, entries);
  await requireOwner(backend, from, entries, override);
  if ((await backend.readLog(to)).length > 0) {
    throw new UserError(`change already exists: ${JSON.stringify(to)}`);
  }
  if ((await backend.tip(to)) !== undefined) {
    throw new UserError(`branch already exists: ${JSON.stringify(to)}`);
  }
  await backend.rename(from, to);
}

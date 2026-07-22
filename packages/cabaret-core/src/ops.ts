import {
  assertChangeExists,
  assertNotArchived,
  type Backend,
  type ChangeName,
  changeBase,
  changeDiff,
  conflictsBetween,
  currentArchived,
  currentBase,
  currentOwner,
  currentParent,
  currentPermanent,
  currentReviewers,
  currentReviewing,
  diffBetween,
  ensureBranch,
  type FilePath,
  freshestReading,
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
import { isConnectivityError } from "./connectivity.js";
import { UserError } from "./error.js";
import {
  assertObligationsSatisfied,
  isSatisfied,
  landBlockers,
  obligationStatuses,
  outstanding,
  UnreviewedParentError,
} from "./obligations.js";
import { currentSelf, isSelf } from "./self.js";
import { reviewLeft } from "./summary.js";

/**
 * The parent is archived — set aside as not landing, or done because a land
 * archived it — so building on it would stack work on a dead end. A landed
 * parent's error names where its code went, since that is the parent to
 * build on instead. The message states the fact and the fix; each frontend
 * attaches its own override remedy before showing it.
 */
export class ArchivedParentError extends UserError {
  constructor(
    readonly parent: ChangeName,
    readonly landedInto?: ChangeName,
  ) {
    super(
      landedInto === undefined
        ? `parent ${JSON.stringify(parent)} is archived; run \`cab archive --undo\` first`
        : `parent ${JSON.stringify(parent)} landed into ${JSON.stringify(landedInto)}; build on that instead`,
    );
  }
}

/** Fail unless `parent` may be built on: an archived parent is a dead end. */
function assertParentLive(parent: ChangeName, parentEntries: readonly LogEntry[]): void {
  if (currentArchived(parentEntries)) {
    throw new ArchivedParentError(
      parent,
      landedMerge(parentEntries) !== undefined ? currentParent(parent, parentEntries) : undefined,
    );
  }
}

/**
 * Create a change, initializing its log with a parent, a base, and an owner
 * (the current user unless `owner` says otherwise). A branch that does not
 * exist yet is created at the parent's tip; an existing branch is adopted
 * with the last revision shared with the parent as its base. Parent and
 * adopted branch alike read freshest — the descendant-most of the local tip
 * and origin's last-fetched copy — and diverged readings fail until synced.
 * An archived parent is a dead end and fails, short of the override. The
 * change must not already exist.
 * Review starts with nobody asked — the change is a draft until widened —
 * though the owner may record self-review at any stage. `permanent` marks
 * the change as structure expected to outlive its lands.
 */
export async function createChange(
  backend: Backend,
  now: () => TimestampMs,
  change: ChangeName,
  parent: ChangeName,
  evenThoughParentArchived: boolean,
  owner?: UserName,
  permanent = false,
): Promise<void> {
  if (change === parent) {
    throw new UserError(`change cannot be its own parent: ${JSON.stringify(change)}`);
  }
  if ((await backend.readLog(change)).length > 0) {
    throw new UserError(`change already exists: ${JSON.stringify(change)}`);
  }
  if (!evenThoughParentArchived) {
    assertParentLive(parent, await backend.readLog(parent));
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
    ...(permanent ? [{ timestamp: now(), user, action: { kind: "set-permanent", permanent } as const }] : []),
  ]);
}

/** Record who is asked to review `change`. */
export async function setReviewing(
  backend: Backend,
  now: () => TimestampMs,
  change: ChangeName,
  entries: readonly LogEntry[],
  reviewing: Reviewing,
): Promise<void> {
  assertChangeExists(change, entries);
  await backend.appendLog(change, [
    { timestamp: now(), user: await backend.currentUser(), action: { kind: "set-reviewing", reviewing } },
  ]);
}

/**
 * Archive `change` — set it aside as not landing — or bring it back. Nothing
 * is deleted: the branch and log stay, todos just stop asking after the
 * change and `land` refuses it until unarchived. Unarchiving a change that
 * landed reopens it: a rebase then starts its next cycle.
 */
export async function setArchived(
  backend: Backend,
  now: () => TimestampMs,
  change: ChangeName,
  entries: readonly LogEntry[],
  archived: boolean,
): Promise<void> {
  assertChangeExists(change, entries);
  if (archived && currentPermanent(entries)) {
    throw new UserError(`change is permanent: ${JSON.stringify(change)}; run \`cab permanent set false\` first`);
  }
  await backend.appendLog(change, [
    { timestamp: now(), user: await backend.currentUser(), action: { kind: "set-archived", archived } },
  ]);
}

/**
 * Record whether `change` is permanent — structure expected to outlive its
 * lands rather than archive on them.
 */
export async function setPermanent(
  backend: Backend,
  now: () => TimestampMs,
  change: ChangeName,
  entries: readonly LogEntry[],
  permanent: boolean,
): Promise<void> {
  assertChangeExists(change, entries);
  await backend.appendLog(change, [
    { timestamp: now(), user: await backend.currentUser(), action: { kind: "set-permanent", permanent } },
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
  const from = currentReviewing(entries);
  let to = widerReviewing(from);
  if (to === undefined) {
    throw new UserError(`everyone is already reviewing ${JSON.stringify(change)}`);
  }
  const diff = await changeDiff(backend, change, entries);
  const owes = async (user: UserName): Promise<boolean> => (await reviewLeft(backend, entries, user, diff)).size > 0;
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
 * onto them would bake them in as resolved content. Rebasing a change that
 * has landed starts its next cycle: the parent contains the landed work, so
 * the base advances past it and the diff empties.
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
 * each change's rebase finds its parent already at rest. An archived change
 * is set aside where it stands and is skipped; its descendants still rebase
 * onto its tip. When one change fails — a conflicting merge commits its
 * markers and counts — the rebases before it stand, and rerunning the chain
 * resumes once it is fixed.
 */
export async function rebaseChain(
  backend: Backend,
  now: () => TimestampMs,
  chain: readonly ChainLink[],
  overrides: RebaseOverrides,
): Promise<void> {
  for (const { change, entries } of chain) {
    if (currentArchived(entries)) {
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
  /**
   * Where the landed diff's review settles per user, from the parent's
   * obligations as the land found them; undefined for a trunk parent, which
   * owes no review. `recordLand` writes it into the logs — after the land,
   * the review entries alone answer, atomically with the landing.
   */
  readonly settling:
    | {
        readonly parentBase: Revision;
        /** Users with no review still owed on the parent: the landed diff answers to the landed change's log. */
        readonly fulfilled: readonly UserName[];
        /** Users the parent still expects review from: the landed diff joins their catch-up in the parent. */
        readonly unfulfilled: readonly UserName[];
      }
    | undefined;
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
 * Check that `target` may land now — live, owned by the current user, with a
 * live parent, with commits of its own past any earlier land, free of
 * unresolved conflicts, merging cleanly onto the parent's tip when the
 * parent moved on, and with its review obligations satisfied — and resolve
 * the endpoints the landing writes. `overrides` skips the checks it names.
 */
export async function prepareLand(
  backend: Backend,
  target: ChangeName,
  entries: readonly LogEntry[],
  overrides: LandOverrides,
): Promise<PreparedLand> {
  assertNotArchived(target, entries);
  await requireOwner(backend, target, entries, overrides.notOwner);
  const parent = currentParent(target, entries);
  // An archived parent is set aside — or done, when a land archived it — so
  // landing into it would bury the work. A parent that is not a change (an
  // empty log) cannot be.
  const parentEntries = await backend.readLog(parent);
  if (currentArchived(parentEntries)) {
    throw landedMerge(parentEntries) !== undefined
      ? new UserError(
          `${JSON.stringify(target)} would land into ${JSON.stringify(parent)}, which has landed; ` +
            "run `cab reparent` first",
        )
      : new UserError(
          `${JSON.stringify(target)} would land into ${JSON.stringify(parent)}, which is archived; ` +
            "run `cab archive --undo` or `cab reparent` first",
        );
  }
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
  // A change that landed before lands again only from a base past that land:
  // a diff still spanning landed work would write it onto the parent twice —
  // a squash literally duplicating the commits.
  const landed = landedMerge(entries);
  if (landed !== undefined && (!(await backend.hasRevision(landed)) || !(await backend.isAncestor(landed, base)))) {
    throw new UserError(`${JSON.stringify(target)} landed at ${landed}; run \`cab rebase\` to start its next cycle`);
  }
  // Commits that change nothing — say, the merges a reopened change's rebase
  // wrote — would land as an empty commit on the parent.
  if ((await backend.changedFiles(base, tip)).length === 0) {
    throw new UserError(`nothing to land: ${JSON.stringify(target)} changes nothing against ${JSON.stringify(parent)}`);
  }
  assertNoConflict(target, await conflictsBetween(backend, base, tip));
  if (base !== onto) {
    const conflicts = await backend.mergeConflicts(base, tip, onto);
    if (conflicts.length > 0) {
      throw new UserError(
        `${JSON.stringify(target)} conflicts with the tip of ${JSON.stringify(parent)} ` +
          `in ${conflicts.join(", ")}; run \`cab rebase\` first`,
      );
    }
  }
  if (!overrides.unreviewed) {
    const diff = await diffBetween(backend, base, tip);
    await assertObligationsSatisfied(backend, entries, currentOwner(target, entries), diff);
  }
  // A trunk parent has no log and owes nothing. The parent's diff is
  // measured to `onto`, the freshest reading the land merges onto.
  let settling: PreparedLand["settling"];
  if (parentEntries.length > 0) {
    const parentDiff = await diffBetween(backend, await changeBase(backend, parent, parentEntries), onto);
    const statuses = await obligationStatuses(backend, parentEntries, currentOwner(parent, parentEntries), parentDiff);
    const blockers = landBlockers(statuses);
    if (blockers.length > 0 && !overrides.parentUnreviewed) {
      throw new UnreviewedParentError(parent, blockers);
    }
    // Settling asks who still expects to read the parent, whatever kind of
    // review they owe: follow review left there means the landed diff joins
    // that catch-up rather than fast-forwarding past it. Who the landed diff
    // answers to is read from the parent's obligations over that diff itself
    // — the parent's own diff may be empty, as on a permanent change
    // between cycles, and its obligations then name nobody.
    const unsatisfied = statuses.filter((status) => !isSatisfied(status));
    const landingStatuses = await obligationStatuses(
      backend,
      parentEntries,
      currentOwner(parent, parentEntries),
      await diffBetween(backend, base, tip),
    );
    const users = new Set(landingStatuses.flatMap(({ obligation }) => obligation.require.of));
    const owing = new Set(unsatisfied.flatMap(outstanding));
    settling = {
      parentBase: parentDiff.base,
      fulfilled: [...users].filter((user) => !owing.has(user)).sort(),
      unfulfilled: [...owing].sort(),
    };
  }
  // Resolve the identity before any ref moves so a missing identity
  // fails without landing anything.
  const user = await backend.currentUser();
  return { parent, base, onto, tip, user, settling };
}

/**
 * Record `target`'s landing in its log: pin the base — once the parent
 * contains the change, the merge-base with it is useless — and write the
 * land entry. A landing commit that descends from no reviewed history — a
 * squash, or whatever else the forge chose to write — also records the tip
 * that landed.
 *
 * The land concludes by what the change is. An ordinary change is done, so
 * the same append archives it, and its children follow the code to its
 * parent (`reparentLandedChildren`, the caller's half). A permanent change
 * outlives the land: its branch advances to the landing commit — a merge
 * contains the tip; a squash, which descends from none of the change's
 * history, merges in as content the branch already carries — and the base
 * pins there, emptying the diff for the next cycle.
 *
 * The landing also settles the landed diff's review, per `settling`: a user
 * the parent still expects review from reads it combined into the parent's
 * catch-up, so their review of `target` records as complete; everyone else
 * answers to `target`'s log for it, so their review of the parent records
 * through the landing commit. After this, the review entries alone say who
 * has read what — nothing later re-reads the land.
 */
export async function recordLand(
  backend: Backend,
  now: () => TimestampMs,
  target: ChangeName,
  entries: readonly LogEntry[],
  { parent, base, onto, tip, user, settling }: PreparedLand,
  merge: LandedMerge,
): Promise<void> {
  const pin: LogEntry[] =
    currentBase(target, entries) === base ? [] : [{ timestamp: now(), user, action: { kind: "set-base", base } }];
  const review = (reviewer: UserName, file: FilePath, from: Revision, to: Revision): LogEntry => ({
    timestamp: now(),
    user: reviewer,
    action: { kind: "review", file, base: from, tip: to },
  });
  let settled: LogEntry[] = [];
  if (settling !== undefined && settling.unfulfilled.length > 0) {
    const files = await backend.changedFiles(base, tip);
    settled = settling.unfulfilled.flatMap((reviewer) => files.map(({ path }) => review(reviewer, path, base, tip)));
  }
  const permanent = currentPermanent(entries);
  await backend.appendLog(target, [
    ...pin,
    ...settled,
    { timestamp: now(), user, action: { kind: "land", merge: merge.commit, ...(merge.parents > 1 ? {} : { tip }) } },
    ...(permanent ? [] : [{ timestamp: now(), user, action: { kind: "set-archived", archived: true } as const }]),
  ]);
  if (settling !== undefined && settling.fulfilled.length > 0) {
    const landed = await backend.changedFiles(onto, merge.commit);
    await backend.appendLog(
      parent,
      settling.fulfilled.flatMap((reviewer) =>
        landed.map(({ path }) => review(reviewer, path, settling.parentBase, merge.commit)),
      ),
    );
  }
  if (permanent) {
    let next: Revision;
    if (merge.parents > 1) {
      next = merge.commit;
      if ((await ensureBranch(backend, target)) !== next) {
        await backend.advance(target, next);
      }
    } else {
      const conflicts = await backend.mergeOnto(target, base, merge.commit, `Merge land of '${target}'`);
      if (conflicts.length > 0) {
        throw new Error(`merging ${JSON.stringify(target)}'s own landed content conflicted in ${conflicts.join(", ")}`);
      }
      next = await requireTip(backend, target);
    }
    await backend.appendLog(target, [{ timestamp: now(), user, action: { kind: "set-base", base: next } }]);
  }
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
    commit: merge,
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
 * everything below. Archived changes are skipped — a change landed on an
 * earlier run archived with it — so a rerun after a mid-chain failure
 * resumes where it left off; a permanent change lands again whenever the
 * chain below has grown it.
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
  // A live change under an archived one can never reach its ancestor:
  // landing below it would only bury work in a jammed chain, so refuse
  // before any merge moves.
  let parent = currentParent(first.change, first.entries);
  let parentEntries = await backend.readLog(parent);
  for (const { change, entries } of chain) {
    if (!currentArchived(entries) && currentArchived(parentEntries)) {
      throw landedMerge(parentEntries) !== undefined
        ? new UserError(
            `${JSON.stringify(change)} would land into ${JSON.stringify(parent)}, which has landed; ` +
              "run `cab reparent` first",
          )
        : new UserError(
            `${JSON.stringify(change)} would land into ${JSON.stringify(parent)}, which is archived; ` +
              "run `cab archive --undo` or `cab reparent` first",
          );
    }
    parent = change;
    parentEntries = entries;
  }
  for (const { change, entries } of chain.toReversed()) {
    if (currentArchived(entries)) {
      continue;
    }
    await land(change, entries);
  }
}

/**
 * Reparent every child of `landed` onto `parent`, the branch its landing
 * merged into. The landing archived `landed`, so a child pointing at it is
 * stuck; the move follows the code, changes no child's diff — the base stays
 * pinned — and so asks no owner's leave. Children finished in their own
 * right — landed and archived — stay put. Returns the children moved, in
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
    if (currentParent(change, entries) !== landed || (landedMerge(entries) !== undefined && currentArchived(entries))) {
      continue;
    }
    await backend.appendLog(change, [{ timestamp: now(), user, action: { kind: "set-parent", parent } }]);
    moved.push(change);
  }
  return moved;
}

/** The reparent checks the user may explicitly override. */
export interface ReparentOverrides {
  /** Reparent a change the current user does not own. */
  readonly notOwner: boolean;
  /** Reparent onto an archived parent. */
  readonly parentArchived: boolean;
  /** Reparent onto a parent whose local reading has diverged from origin's. */
  readonly parentDiverged: boolean;
}

/**
 * Update `change`'s parent. This is a metadata/log change only, and does not
 * touch code without a subsequent rebase — which is why a diverged parent is
 * overridable here: no reading is chosen until that rebase, which arbitrates
 * with its own override.
 */
export async function reparentChange(
  backend: Backend,
  now: () => TimestampMs,
  change: ChangeName,
  parent: ChangeName,
  overrides: ReparentOverrides,
): Promise<void> {
  if (change === parent) {
    throw new UserError(`change cannot be its own parent: ${JSON.stringify(change)}`);
  }
  const entries = await backend.readLog(change);
  await requireOwner(backend, change, entries, overrides.notOwner);
  if (!overrides.parentArchived) {
    assertParentLive(parent, await backend.readLog(parent));
  }
  // The same liveness `create` demands: a parent is a branch — local or
  // origin's fetched copy — change log or not.
  const reading = await freshestReading(backend, parent);
  if (reading.kind === "none") {
    throw new UserError(`parent branch does not exist: ${JSON.stringify(parent)}`);
  }
  if (reading.kind === "diverged" && !overrides.parentDiverged) {
    throw new DivergedParentError(parent);
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
  await requireOwner(backend, change, entries, override);
  await backend.appendLog(change, [
    { timestamp: now(), user: await backend.currentUser(), action: { kind: "set-owner", owner } },
  ]);
}

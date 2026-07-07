import {
  assertChangeExists,
  assertNotLanded,
  type Backend,
  type CommitHash,
  changeBase,
  currentBase,
  currentOwner,
  currentParent,
  type LogEntry,
  landedMerge,
  landMessage,
  type RefName,
  type TimestampMs,
  type UserName,
} from "./backend.js";
import type { LandMethod } from "./config.js";
import { UserError } from "./error.js";

/**
 * Create a change, initializing its log with a parent, a base, and an owner
 * (the current user unless `owner` says otherwise). A branch that does not
 * exist yet is created at the parent's tip; an existing branch is adopted
 * with the last revision shared with the parent as its base. The change must
 * not already exist.
 */
export async function createChange(
  backend: Backend,
  now: () => TimestampMs,
  change: RefName,
  parent: RefName,
  owner?: UserName,
): Promise<void> {
  if (change === parent) {
    throw new UserError(`change cannot be its own parent: ${JSON.stringify(change)}`);
  }
  if ((await backend.readLog(change)).length > 0) {
    throw new UserError(`change already exists: ${JSON.stringify(change)}`);
  }
  const parentTip = await backend.branchTip(parent);
  if (parentTip === undefined) {
    throw new UserError(`parent branch does not exist: ${JSON.stringify(parent)}`);
  }
  // Resolve the identity before mutating any ref so a missing git identity
  // fails without leaving a branch behind.
  const user = await backend.currentUser();
  const existing = await backend.branchTip(change);
  // A fresh branch is created at the parent's tip, which is therefore its
  // base; an adopted branch is based where it last shared with the parent.
  let base: typeof parentTip;
  if (existing === undefined) {
    await backend.createBranch(change, parentTip);
    base = parentTip;
  } else {
    base = await backend.mergeBase(parent, change);
  }
  await backend.appendLog(change, [
    { timestamp: now(), user, action: { kind: "set-parent", parent } },
    { timestamp: now(), user, action: { kind: "set-base", base } },
    { timestamp: now(), user, action: { kind: "set-owner", owner: owner ?? user } },
  ]);
}

/** One change of a resolved chain, with the log that placed it there. */
export interface ChainLink {
  readonly change: RefName;
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
  ancestor: RefName,
  descendant: RefName,
): Promise<readonly ChainLink[]> {
  const chain: ChainLink[] = [];
  const seen = new Set<RefName>();
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
export async function resolveChain(backend: Backend, changes: readonly RefName[]): Promise<readonly ChainLink[]> {
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
 * Fail unless the current user owns `change`; `override`
 * (--even-though-not-owner) skips the check. A log with no owner is malformed
 * and fails regardless of the override: the flag excuses not being the owner,
 * not a broken log.
 */
export async function requireOwner(
  backend: Backend,
  change: RefName,
  entries: readonly LogEntry[],
  override: boolean,
): Promise<void> {
  const owner = currentOwner(change, entries);
  if (override) {
    return;
  }
  const user = await backend.currentUser();
  if (user !== owner) {
    throw new UserError(
      `${JSON.stringify(change)} is owned by ${JSON.stringify(owner)}, not ${JSON.stringify(user)}; ` +
        "pass --even-though-not-owner to override",
    );
  }
}

/** Rebase `target` onto its parent's tip, then record the new base in the log. */
export async function rebaseChange(
  backend: Backend,
  now: () => TimestampMs,
  target: RefName,
  entries: readonly LogEntry[],
  override: boolean,
): Promise<void> {
  assertNotLanded(target, entries);
  await requireOwner(backend, target, entries, override);
  const parent = currentParent(target, entries);
  const onto = await backend.branchTip(parent);
  if (onto === undefined) {
    throw new UserError(`parent branch does not exist: ${JSON.stringify(parent)}`);
  }
  const base = await changeBase(backend, target, entries);
  // Replay the change's own commits onto the parent's tip. When the change
  // already sits there (base === onto), whether because it was just rebased
  // or an out-of-band `git rebase` put it there, there is nothing to replay.
  if (base !== onto) {
    // Record the base only after a clean rebase: if the rebase stops on
    // conflicts and the user finishes it with git, this line never runs and
    // the stale stored base loses to the merge-base with the parent.
    await backend.rebaseOnto(target, base, onto);
  }
  // Pin the base to the parent's tip so a later parent rewrite cannot slide
  // it back to an ancestor and pull the parent's commits into the diff.
  if (currentBase(target, entries) !== onto) {
    await backend.appendLog(target, [
      { timestamp: now(), user: await backend.currentUser(), action: { kind: "set-base", base: onto } },
    ]);
  }
}

/**
 * Rebase every change of `chain` onto its parent's tip, ancestormost first so
 * each change's rebase finds its parent already at rest. A landed change is
 * frozen where it landed and is skipped; its descendants still rebase onto
 * its tip. When one change fails, the rebases before it stand, and rerunning
 * the chain resumes.
 */
export async function rebaseChain(
  backend: Backend,
  now: () => TimestampMs,
  chain: readonly ChainLink[],
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
export interface PreparedLand {
  readonly parent: RefName;
  readonly base: CommitHash;
  readonly tip: CommitHash;
  readonly user: UserName;
}

/**
 * Check that `target` may land now — unlanded, owned by the current user
 * (unless overridden), with an unlanded parent, sitting on the parent's tip,
 * and with commits of its own — and resolve the endpoints the landing writes.
 */
export async function prepareLand(
  backend: Backend,
  target: RefName,
  entries: readonly LogEntry[],
  override: boolean,
): Promise<PreparedLand> {
  assertNotLanded(target, entries);
  await requireOwner(backend, target, entries, override);
  const parent = currentParent(target, entries);
  // A parent that is itself a landed change is frozen too: landing into it
  // would grow the code its own land froze. A parent that is not a change
  // (an empty log) cannot have landed.
  assertNotLanded(parent, await backend.readLog(parent));
  const parentTip = await backend.branchTip(parent);
  if (parentTip === undefined) {
    throw new UserError(`parent branch does not exist: ${JSON.stringify(parent)}`);
  }
  const base = await changeBase(backend, target, entries);
  if (base !== parentTip) {
    throw new UserError(
      `${JSON.stringify(target)} is not based on the tip of ${JSON.stringify(parent)}; run \`cabaret rebase\` first`,
    );
  }
  // Pin to the branch namespace so a same-named tag cannot shadow the
  // change's tip.
  const tip = await backend.resolveCommit(`refs/heads/${target}`);
  if (tip === base) {
    throw new UserError(`nothing to land: ${JSON.stringify(target)} has no commits of its own`);
  }
  // Resolve the identity before any ref moves so a missing git identity
  // fails without landing anything.
  const user = await backend.currentUser();
  return { parent, base, tip, user };
}

/**
 * Record `target`'s landing in its log: pin the base — once the parent
 * contains the change, the merge-base with it is useless, so `changeBase`
 * serves the stored base of a landed change forever — and write the land
 * entry. A squash's commit descends from no reviewed history, so the entry
 * also freezes the tip that landed.
 */
export async function recordLand(
  backend: Backend,
  now: () => TimestampMs,
  target: RefName,
  entries: readonly LogEntry[],
  { base, tip, user }: PreparedLand,
  method: LandMethod,
  merge: CommitHash,
): Promise<void> {
  const pin: LogEntry[] =
    currentBase(target, entries) === base ? [] : [{ timestamp: now(), user, action: { kind: "set-base", base } }];
  await backend.appendLog(target, [
    ...pin,
    { timestamp: now(), user, action: { kind: "land", merge, ...(method === "squash" ? { tip } : {}) } },
  ]);
}

/**
 * Land `target` into its parent: write it onto the parent branch as a commit
 * marked as landing — a land merge, or one squash commit — and record the
 * landing in the log. The change must sit on its parent's tip; rebase first
 * if it does not.
 */
export async function landChange(
  backend: Backend,
  now: () => TimestampMs,
  target: RefName,
  entries: readonly LogEntry[],
  method: LandMethod,
  override: boolean,
): Promise<void> {
  const prepared = await prepareLand(backend, target, entries, override);
  const { parent, base, tip } = prepared;
  const merge =
    method === "merge"
      ? await backend.merge(parent, base, tip, landMessage(target))
      : await backend.squash(parent, base, tip, landMessage(target));
  await recordLand(backend, now, target, entries, prepared, method, merge);
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
  land: (change: RefName, entries: readonly LogEntry[]) => Promise<void>,
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
 * Update `change`'s parent. This is a metadata/log change only, and does not
 * touch code without a subsequent rebase.
 */
// TODO: validate that `parent` names a real change before logging.
export async function reparentChange(
  backend: Backend,
  now: () => TimestampMs,
  change: RefName,
  parent: RefName,
  override: boolean,
): Promise<void> {
  const entries = await backend.readLog(change);
  assertNotLanded(change, entries);
  await requireOwner(backend, change, entries, override);
  await backend.appendLog(change, [
    { timestamp: now(), user: await backend.currentUser(), action: { kind: "set-parent", parent } },
  ]);
}

/** Transfer `change` to a new owner. Only the current owner may transfer it. */
export async function transferChange(
  backend: Backend,
  now: () => TimestampMs,
  change: RefName,
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
export async function renameChange(backend: Backend, from: RefName, to: RefName, override: boolean): Promise<void> {
  const entries = await backend.readLog(from);
  assertChangeExists(from, entries);
  assertNotLanded(from, entries);
  await requireOwner(backend, from, entries, override);
  if ((await backend.readLog(to)).length > 0) {
    throw new UserError(`change already exists: ${JSON.stringify(to)}`);
  }
  if ((await backend.branchTip(to)) !== undefined) {
    throw new UserError(`branch already exists: ${JSON.stringify(to)}`);
  }
  await backend.renameChange(from, to);
}

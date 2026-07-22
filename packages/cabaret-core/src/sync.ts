import {
  assertChangeExists,
  type Backend,
  type ChangeName,
  conflictsBetween,
  ensureBranch,
  type FilePath,
  landedMerge,
  type TimestampMs,
} from "./backend.js";
import { isConnectivityError } from "./connectivity.js";
import {
  type AbsorbResult,
  absorbForgeChange,
  type Forge,
  type PublishResult,
  publishForgeChange,
  syncedForgeChange,
} from "./forge.js";
import { assertNoConflict, pushAdvances } from "./ops.js";

/** What the ambient half of a fetch moved, for hosts to narrate. */
export interface FetchedLocal {
  /** The changes whose logs were merged with origin's. */
  readonly synced: readonly ChangeName[];
  /** The branches fast-forwarded onto origin's fresh copies. */
  readonly advanced: readonly ChangeName[];
  /** The branches pushed, origin having trailed them by descent. */
  readonly pushed: readonly ChangeName[];
  /** The diverged branches whose readings merged without conflict. */
  readonly joined: readonly ChangeName[];
}

/**
 * Fetch everything unobtrusive from origin, no forge involved: refresh
 * origin's copies, fast-forward branches whose moves lose nothing — a clean
 * workspace's working tree follows its branch; a dirty one holds it put —
 * and merge every change's log with origin's. `fetchForge` runs the same
 * steps and absorbs forge activity besides.
 */
export async function fetchLocal(backend: Backend): Promise<FetchedLocal> {
  await backend.fetchOrigin();
  const advanced = await backend.advanceBranches();
  const synced = await backend.syncLogs();
  const joined = await backend.joinBranches(synced);
  return { synced, advanced, joined, pushed: await pushAdvances(backend, synced) };
}

/** What a per-change reconcile settled, for hosts to narrate. */
export interface ReconcileResult {
  /**
   * Whether origin was unreachable: nothing ran and nothing queued — a later
   * reconcile converges, and logs already absorbed origin's entries when
   * last fetched.
   */
  readonly offline: boolean;
  /** What absorbing the forge's side recorded; undefined without a forge change. */
  readonly absorbed: AbsorbResult | undefined;
  /**
   * What publishing settled on the forge; undefined without a forge, for a
   * landed change (frozen, nothing to settle), or for a change whose forge
   * change does not exist and is not yet due — none is opened before the
   * head reaches origin or while it adds nothing over the parent, and
   * archiving asks for no new one.
   */
  readonly published: PublishResult | undefined;
}

/** What a sync did, for hosts to narrate. */
export interface SyncResult extends ReconcileResult {
  /**
   * Origin's copy merged into the branch, with the paths the merge left
   * conflicted; undefined when the branch already carried origin's reading.
   */
  readonly joined: { readonly conflicts: readonly FilePath[] } | undefined;
}

/**
 * Merge origin's reading of `change` into its branch: a fast-forward when the
 * branch has nothing of its own, a merge commit otherwise — conflicts commit,
 * markers in place, for fixing in the owner's own time — and nothing at all
 * when the branch already carries origin's reading. A branch whose files
 * already carry markers must be fixed before it joins again: merging onto
 * them would bake them in as resolved content.
 */
async function joinBranch(
  backend: Backend,
  change: ChangeName,
): Promise<{ readonly conflicts: readonly FilePath[] } | undefined> {
  const origin = await backend.originTip(change);
  const tip = await ensureBranch(backend, change);
  if (origin === undefined || origin === tip || (await backend.isAncestor(origin, tip))) {
    return undefined;
  }
  const base = await backend.mergeBase(tip, origin);
  assertNoConflict(change, await conflictsBetween(backend, base, tip));
  const conflicts = await backend.mergeOnto(change, base, origin, `Merge origin's '${change}' into ${change}`);
  return { conflicts };
}

/**
 * Reconcile `change`'s shared state without touching its branch or working
 * tree: merge and push its log, and settle its forge change both ways —
 * absorbing the forge's side first, then publishing what remains as local
 * intent, opening a forge change if one is due. The transport half of
 * `syncChange`, which commands run write-through after appending to a log:
 * the append was the publication intent, so carrying it asks no further
 * consent. Every step converges state, so rerunning after any failure
 * resumes where it left off.
 *
 * Offline — origin unreachable, as `isConnectivityError` reads it — nothing
 * runs and nothing queues; a later reconcile converges. Any other failure
 * surfaces.
 */
export async function reconcileChange(
  backend: Backend,
  now: () => TimestampMs,
  forge: Forge | undefined,
  change: ChangeName,
): Promise<ReconcileResult> {
  try {
    await backend.syncLog(change);
    let absorbed: AbsorbResult | undefined;
    let published: PublishResult | undefined;
    const current = await backend.readLog(change);
    if (forge !== undefined && landedMerge(current) === undefined) {
      const user = await backend.currentUser();
      const found = await syncedForgeChange(backend, now, user, forge, change, current);
      if (found !== undefined) {
        absorbed = await absorbForgeChange(backend, now, user, forge, change, await backend.readLog(change), found);
      }
      published = await publishForgeChange(backend, now, forge, change, await backend.readLog(change), found);
      await backend.syncLog(change);
    }
    return { offline: false, absorbed, published };
  } catch (error) {
    if (!isConnectivityError(error)) {
      throw error;
    }
    return { offline: true, absorbed: undefined, published: undefined };
  }
}

/**
 * Sync `change` with origin and its forge: merge origin's copy of the branch
 * into the local one (as `joinBranch`), push the result, and reconcile its
 * log and forge change (as `reconcileChange`).
 *
 * Offline, only the join runs, against origin's last-fetched readings.
 */
export async function syncChange(
  backend: Backend,
  now: () => TimestampMs,
  forge: Forge | undefined,
  change: ChangeName,
): Promise<SyncResult> {
  const entries = await backend.readLog(change);
  assertChangeExists(change, entries);
  try {
    await backend.fetchOrigin();
  } catch (error) {
    if (!isConnectivityError(error)) {
      throw error;
    }
    return { offline: true, joined: await joinBranch(backend, change), absorbed: undefined, published: undefined };
  }
  const joined = await joinBranch(backend, change);
  await backend.push(change);
  return { joined, ...(await reconcileChange(backend, now, forge, change)) };
}

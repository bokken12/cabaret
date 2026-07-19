import {
  assertChangeExists,
  type Backend,
  type ChangeName,
  conflictedFiles,
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
import { assertNoConflict } from "./ops.js";

/** What the ambient half of a fetch moved, for hosts to narrate. */
export interface FetchedLocal {
  /** The changes whose logs were merged with origin's. */
  readonly synced: readonly ChangeName[];
  /** The branches fast-forwarded onto origin's fresh copies. */
  readonly advanced: readonly ChangeName[];
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
  return { synced, advanced };
}

/** What a sync did, for hosts to narrate. */
export interface SyncResult {
  /**
   * Whether origin was unreachable: only the local join ran, against the
   * last-fetched readings, and running again online finishes the exchange.
   */
  readonly offline: boolean;
  /**
   * Origin's copy merged into the branch, with the paths the merge left
   * conflicted; undefined when the branch already carried origin's reading.
   */
  readonly joined: { readonly conflicts: readonly FilePath[] } | undefined;
  /** What absorbing the forge's side recorded; undefined without a forge change. */
  readonly absorbed: AbsorbResult | undefined;
  /**
   * What publishing settled on the forge; undefined without a forge, for a
   * landed change (frozen, nothing to settle), or for an archived change with
   * no forge change (converged already: archiving asks for no new one).
   */
  readonly published: PublishResult | undefined;
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
  assertNoConflict(change, await conflictedFiles(backend, tip, await backend.changedFiles(base, tip)));
  const conflicts = await backend.mergeOnto(change, base, origin, `Merge origin's '${change}' into ${change}`);
  return { conflicts };
}

/**
 * Sync `change` with origin and its forge: merge origin's copy of the branch
 * into the local one (as `joinBranch`), push the result, reconcile the forge
 * change — absorbing the forge's side first, then publishing what remains as
 * local intent, opening a forge change if none exists — and sync the log.
 * Every step converges state that syncing again would converge no further,
 * so rerunning after any failure resumes where it left off.
 *
 * Offline — origin unreachable, as `isConnectivityError` reads it — only the
 * join runs, against origin's last-fetched readings; logs already absorbed
 * origin's entries when last fetched, so there is nothing else to do without
 * the network. Any other failure surfaces.
 */
export async function syncChange(
  backend: Backend,
  now: () => TimestampMs,
  forge: Forge | undefined,
  change: ChangeName,
): Promise<SyncResult> {
  const entries = await backend.readLog(change);
  assertChangeExists(change, entries);
  let offline = false;
  try {
    await backend.fetchOrigin();
  } catch (error) {
    if (!isConnectivityError(error)) {
      throw error;
    }
    offline = true;
  }
  if (offline) {
    return { offline, joined: await joinBranch(backend, change), absorbed: undefined, published: undefined };
  }
  await backend.syncLog(change);
  const joined = await joinBranch(backend, change);
  await backend.push(change);
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
  }
  await backend.syncLog(change);
  return { offline, joined, absorbed, published };
}

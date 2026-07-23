import type { Backend, ChangeName, RefSnapshot, Revision } from "./backend.js";

/**
 * The reads of mutable state a pinned computation made: each ref by name —
 * recorded as what the snapshot held, absence included — and each revision
 * probed and found missing from this clone. Everything else a pinned backend
 * answers is a pure function of immutable objects, so a result computed over
 * one holds exactly while these reads do: whoever stores the result keys it
 * by them.
 *
 * Presence is treated as monotone — a fetch only adds objects — so probes
 * that found their object are not recorded; only a gc could invalidate one,
 * and everything stored against these reads is a discardable cache anyway.
 */
export interface RefReads {
  readonly heads: ReadonlyMap<ChangeName, Revision | undefined>;
  readonly origins: ReadonlyMap<ChangeName, Revision | undefined>;
  readonly logs: ReadonlyMap<ChangeName, Revision | undefined>;
  readonly absent: ReadonlySet<Revision>;
}

/** A backend view pinned at one `RefSnapshot`, and the reads made through it so far. */
export interface PinnedBackend {
  readonly backend: Backend;
  readonly reads: RefReads;
}

/**
 * A `Backend` view whose every read of mutable state is served from
 * `snapshot` and recorded: ref reads answer from the snapshot's maps, log
 * entries read pinned at the snapshot's log commit, and revision-presence
 * probes note what was missing. Pure queries of immutable objects — diffs,
 * file contents, ancestry — pass through. Everything else the interface
 * carries (configuration, workspaces, every write) is outside what a
 * snapshot pins, and throws.
 */
export function pinBackend(base: Backend, snapshot: RefSnapshot): PinnedBackend {
  const heads = new Map<ChangeName, Revision | undefined>();
  const origins = new Map<ChangeName, Revision | undefined>();
  const logs = new Map<ChangeName, Revision | undefined>();
  const absent = new Set<Revision>();
  const record = (
    reads: Map<ChangeName, Revision | undefined>,
    pinned: ReadonlyMap<ChangeName, Revision>,
    change: ChangeName,
  ): Revision | undefined => {
    const revision = pinned.get(change);
    reads.set(change, revision);
    return revision;
  };
  const unavailable = (method: string): never => {
    throw new Error(`${method} is not available on a pinned backend`);
  };
  const backend: Backend = {
    root: base.root,
    parseRevision: base.parseRevision,
    parseName: base.parseName,
    resolveFile: (raw) => base.resolveFile(raw),

    // Reads of mutable state: served from the snapshot and recorded.
    tip: async (change) => record(heads, snapshot.heads, change),
    originTip: async (change) => record(origins, snapshot.origins, change),
    readLog: async (change) => {
      const tip = record(logs, snapshot.logs, change);
      return tip === undefined ? [] : base.readLogAt(tip);
    },
    hasRevision: async (revision) => {
      const has = await base.hasRevision(revision);
      if (!has) {
        absent.add(revision);
      }
      return has;
    },

    // Pure queries of immutable objects: passed through.
    readLogAt: (tip) => base.readLogAt(tip),
    mergeBase: (a, b) => base.mergeBase(a, b),
    isAncestor: (ancestor, descendant) => base.isAncestor(ancestor, descendant),
    mergedTip: (merge) => base.mergedTip(merge),
    mergedOnto: (merge) => base.mergedOnto(merge),
    mergeConflicts: (mergeBase, tip, onto) => base.mergeConflicts(mergeBase, tip, onto),
    chainMerges: (chainBase, tip, scan) => base.chainMerges(chainBase, tip, scan),
    readFile: (commit, file) => base.readFile(commit, file),
    changedFiles: (diffBase, tip) => base.changedFiles(diffBase, tip),
    nonWhitespaceChanges: (diffBase, tip) => base.nonWhitespaceChanges(diffBase, tip),

    // Everything else reads or moves state the snapshot does not pin.
    currentChange: () => unavailable("currentChange"),
    currentUser: () => unavailable("currentUser"),
    config: () => unavailable("config"),
    configAll: () => unavailable("configAll"),
    configSet: () => unavailable("configSet"),
    configAdd: () => unavailable("configAdd"),
    configUnset: () => unavailable("configUnset"),
    setupRecommendations: () => unavailable("setupRecommendations"),
    resolveCommit: () => unavailable("resolveCommit"),
    originFetched: () => unavailable("originFetched"),
    refSnapshot: () => unavailable("refSnapshot"),
    create: () => unavailable("create"),
    advance: () => unavailable("advance"),
    workspaces: () => unavailable("workspaces"),
    addWorkspace: () => unavailable("addWorkspace"),
    removeWorkspace: () => unavailable("removeWorkspace"),
    checkout: () => unavailable("checkout"),
    commit: () => unavailable("commit"),
    editedFiles: () => unavailable("editedFiles"),
    mergeOnto: () => unavailable("mergeOnto"),
    merge: () => unavailable("merge"),
    squash: () => unavailable("squash"),
    push: () => unavailable("push"),
    fetch: () => unavailable("fetch"),
    fetchOrigin: () => unavailable("fetchOrigin"),
    advanceBranches: () => unavailable("advanceBranches"),
    syncLog: () => unavailable("syncLog"),
    syncLogs: () => unavailable("syncLogs"),
    joinBranches: () => unavailable("joinBranches"),
    forgeSweepState: () => unavailable("forgeSweepState"),
    publishForgeSweepState: () => unavailable("publishForgeSweepState"),
    wipeReviewState: () => unavailable("wipeReviewState"),
    wipeOriginLogs: () => unavailable("wipeOriginLogs"),
    listChanges: () => unavailable("listChanges"),
    appendLog: () => unavailable("appendLog"),
    deleteLog: () => unavailable("deleteLog"),
    readCache: () => unavailable("readCache"),
    writeCache: () => unavailable("writeCache"),
  };
  return { backend, reads: { heads, origins, logs, absent } };
}

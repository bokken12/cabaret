import type { Brain, BrainEntry, FileState, FileStatus } from './types.js';

/**
 * Classify one file's current PR state against a reviewer's brain entry.
 *
 * - No brain entry → `unreviewed` (show the file's full base→tip diff).
 * - Brain matches PR exactly → `reviewed` (silence).
 * - Tip blob unchanged but base moved → `revUpdate` (brain can advance
 *   silently; the file's contribution to the PR didn't actually change).
 * - Anything else → `stale` (reviewer sees the ddiff of `oldBase, oldTip`
 *   vs `newBase, newTip`).
 */
export function classifyFile(brain: BrainEntry | undefined, current: FileState): FileStatus {
  if (!brain) {
    return { kind: 'unreviewed', path: current.path, diff2: current };
  }
  if (brain.baseBlob === current.baseBlob && brain.tipBlob === current.tipBlob) {
    return { kind: 'reviewed', path: current.path };
  }
  if (brain.tipBlob === current.tipBlob) {
    return {
      kind: 'revUpdate',
      path: current.path,
      diff4: {
        path: current.path,
        oldBase: brain.baseBlob,
        oldTip: brain.tipBlob,
        newBase: current.baseBlob,
        newTip: current.tipBlob,
      },
    };
  }
  return {
    kind: 'stale',
    path: current.path,
    diff4: {
      path: current.path,
      oldBase: brain.baseBlob,
      oldTip: brain.tipBlob,
      newBase: current.baseBlob,
      newTip: current.tipBlob,
    },
  };
}

/**
 * Classify every file changed by a PR against a reviewer's brain.
 */
export function classifyPr(brain: Brain, changedFiles: readonly FileState[]): readonly FileStatus[] {
  return changedFiles.map((cf) => classifyFile(brain.entries.get(cf.path), cf));
}

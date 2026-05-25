import type { Brain, BrainEntry, Diff4, FileState, FileStatus } from './types.js';

/**
 * Classify one file's current PR state against a reviewer's brain entry.
 *
 * - No brain entry → `unreviewed` (show the file's full base→tip diff).
 * - Brain matches PR exactly → `reviewed` (silence).
 * - Tip blob unchanged but base moved → `revUpdate` (brain can advance
 *   silently; the file's contribution to the PR did not actually change).
 * - Anything else → `stale` (reviewer sees the ddiff of `previous` vs
 *   `current`, computable via `diff4FromBrain`).
 */
export function classifyFile(previous: BrainEntry | undefined, current: FileState): FileStatus {
  if (!previous) {
    return { kind: 'unreviewed', path: current.path, current };
  }
  if (previous.baseBlob === current.baseBlob && previous.tipBlob === current.tipBlob) {
    return { kind: 'reviewed', path: current.path };
  }
  if (previous.tipBlob === current.tipBlob) {
    return { kind: 'revUpdate', path: current.path, current, previous };
  }
  return { kind: 'stale', path: current.path, current, previous };
}

/**
 * Classify every file changed by a PR against a reviewer's brain.
 */
export function classifyPr(brain: Brain, changedFiles: readonly FileState[]): readonly FileStatus[] {
  return changedFiles.map((cf) => classifyFile(brain.entries.get(cf.path), cf));
}

/**
 * Derive a `Diff4` (the four-blob diamond used by the diff renderer) from a
 * brain entry and the file's current PR state. Useful for callers that
 * receive a `stale` or `revUpdate` status and want to materialize the
 * diff-of-diffs.
 */
export function diff4FromBrain(previous: BrainEntry, current: FileState): Diff4 {
  return {
    path: current.path,
    oldBase: previous.baseBlob,
    oldTip: previous.tipBlob,
    newBase: current.baseBlob,
    newTip: current.tipBlob,
  };
}

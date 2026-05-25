import type { Brain, FileState, Path } from './types.js';

/**
 * The result of advancing a brain through review of one or more files.
 *
 * `advanced` lists paths whose brain entry was actually moved — files
 * whose entry already matched the requested state are skipped so callers
 * can report "nothing to do" without re-writing identical state. Named
 * separately from the `reviewed` FileStatus kind so result and state
 * vocabulary don't collide.
 */
export type ReviewResult = {
  readonly brain: Brain;
  readonly advanced: readonly Path[];
};

/**
 * Mark each file in `files` as reviewed by `brain`'s owner: record its
 * current `(baseBlob, tipBlob)` with `markKind: 'user'`, taking explicit
 * responsibility for the state.
 *
 * Entries already matching the requested state are left untouched; they
 * appear neither in the returned brain (unchanged) nor in `advanced`.
 * Entries for paths not mentioned in `files` are preserved verbatim, which
 * matters for brain entries left behind by earlier revisions of the PR
 * (e.g. a file that has since stopped changing).
 *
 * `markKind: 'user'` here — including for revUpdate-shaped advances — is
 * intentional: `internal` is reserved for advances the brain makes without
 * a human action (e.g. automatic rev-update detection). Iron calls this
 * pair `User` / `Internal__fully_reviewed`.
 */
export function markReviewed(brain: Brain, files: readonly FileState[]): ReviewResult {
  const entries = new Map(brain.entries);
  const advanced: Path[] = [];
  for (const f of files) {
    const previous = entries.get(f.path);
    if (previous?.baseBlob === f.baseBlob && previous.tipBlob === f.tipBlob) {
      continue;
    }
    entries.set(f.path, {
      path: f.path,
      baseBlob: f.baseBlob,
      tipBlob: f.tipBlob,
      markKind: 'user',
    });
    advanced.push(f.path);
  }
  return { brain: { ...brain, entries }, advanced };
}

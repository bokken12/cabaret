import { describe, expect, it } from 'vitest';
import { markReviewed } from '../review.js';
import {
  BlobSha,
  type Brain,
  type BrainEntry,
  type FileState,
  Path,
  PrNumber,
  UserId,
} from '../types.js';

function fs(path: string, base: string | null, tip: string): FileState {
  return {
    path: Path(path),
    baseBlob: base === null ? null : BlobSha(base),
    tipBlob: BlobSha(tip),
  };
}

function be(
  path: string,
  base: string | null,
  tip: string,
  mark: 'user' | 'internal' = 'user',
): BrainEntry {
  return { ...fs(path, base, tip), markKind: mark };
}

function brainOf(...entries: BrainEntry[]): Brain {
  return {
    user: UserId('joel@example.com'),
    pr: PrNumber(42),
    entries: new Map(entries.map((e) => [e.path, e])),
  };
}

describe('markReviewed', () => {
  it('adds entries for unreviewed files with markKind=user', () => {
    const brain = brainOf();
    const a = fs('a', 'b1', 't1');
    const b = fs('b', null, 't2');
    const result = markReviewed(brain, [a, b]);
    expect(result.advanced).toEqual([Path('a'), Path('b')]);
    expect([...result.brain.entries.values()]).toEqual([
      { ...a, markKind: 'user' },
      { ...b, markKind: 'user' },
    ]);
  });

  it('advances stale entries and reports them in advanced', () => {
    const brain = brainOf(be('a', 'b1', 't1'));
    const a = fs('a', 'b1', 't2');
    const result = markReviewed(brain, [a]);
    expect(result.advanced).toEqual([Path('a')]);
    expect(result.brain.entries.get(Path('a'))).toEqual({ ...a, markKind: 'user' });
  });

  it('advances revUpdate entries (tip same, base moved) with markKind=user', () => {
    const brain = brainOf(be('a', 'b1', 't1'));
    const a = fs('a', 'b2', 't1');
    const result = markReviewed(brain, [a]);
    expect(result.advanced).toEqual([Path('a')]);
    expect(result.brain.entries.get(Path('a'))).toEqual({ ...a, markKind: 'user' });
  });

  it('skips files whose entry already matches', () => {
    const brain = brainOf(be('a', 'b1', 't1'));
    const result = markReviewed(brain, [fs('a', 'b1', 't1')]);
    expect(result.advanced).toEqual([]);
    expect(result.brain.entries.get(Path('a'))).toEqual(be('a', 'b1', 't1'));
  });

  it('leaves a matching internal entry untouched (markKind not promoted)', () => {
    const brain = brainOf(be('a', 'b1', 't1', 'internal'));
    const result = markReviewed(brain, [fs('a', 'b1', 't1')]);
    expect(result.advanced).toEqual([]);
    expect(result.brain.entries.get(Path('a'))).toEqual(be('a', 'b1', 't1', 'internal'));
  });

  it('preserves brain entries for paths not mentioned in files', () => {
    const untouched = be('keep', 'kb', 'kt');
    const brain = brainOf(untouched, be('a', 'b1', 't1'));
    const result = markReviewed(brain, [fs('a', 'b1', 't2')]);
    expect(result.brain.entries.get(Path('keep'))).toEqual(untouched);
  });

  it('returns an empty result when files is empty', () => {
    const a = be('a', 'b1', 't1');
    const brain = brainOf(a);
    const result = markReviewed(brain, []);
    expect(result.advanced).toEqual([]);
    expect([...result.brain.entries.values()]).toEqual([a]);
  });
});

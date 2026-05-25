import { describe, expect, it } from 'vitest';
import { markReviewed } from '../review.js';
import {
  BlobSha,
  type Brain,
  type BrainEntry,
  type FileState,
  Path,
  PrNumber,
  Timestamp,
  UserId,
} from '../types.js';

const T0 = Timestamp(1_700_000_000_000);
const T1 = Timestamp(1_700_000_001_000);

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
  ts: Timestamp = T0,
): BrainEntry {
  return { ...fs(path, base, tip), markKind: mark, lastModifiedAt: ts };
}

function brainOf(...entries: BrainEntry[]): Brain {
  return {
    user: UserId('alice@example.com'),
    pr: PrNumber(42),
    entries: new Map(entries.map((e) => [e.path, e])),
  };
}

describe('markReviewed', () => {
  it('adds entries for unreviewed files with markKind=user and the supplied timestamp', () => {
    const brain = brainOf();
    const a = fs('a', 'b1', 't1');
    const b = fs('b', null, 't2');
    const result = markReviewed(brain, [a, b], T1);
    expect(result.advanced).toEqual([Path('a'), Path('b')]);
    expect([...result.brain.entries.values()]).toEqual([
      { ...a, markKind: 'user', lastModifiedAt: T1 },
      { ...b, markKind: 'user', lastModifiedAt: T1 },
    ]);
  });

  it('advances stale entries, stamps them with `now`, and reports them in advanced', () => {
    const brain = brainOf(be('a', 'b1', 't1', 'user', T0));
    const a = fs('a', 'b1', 't2');
    const result = markReviewed(brain, [a], T1);
    expect(result.advanced).toEqual([Path('a')]);
    expect(result.brain.entries.get(Path('a'))).toEqual({
      ...a,
      markKind: 'user',
      lastModifiedAt: T1,
    });
  });

  it('advances revUpdate entries (tip same, base moved) with markKind=user', () => {
    const brain = brainOf(be('a', 'b1', 't1', 'user', T0));
    const a = fs('a', 'b2', 't1');
    const result = markReviewed(brain, [a], T1);
    expect(result.advanced).toEqual([Path('a')]);
    expect(result.brain.entries.get(Path('a'))).toEqual({
      ...a,
      markKind: 'user',
      lastModifiedAt: T1,
    });
  });

  it('skips files whose entry already matches and does not bump the timestamp', () => {
    const existing = be('a', 'b1', 't1', 'user', T0);
    const brain = brainOf(existing);
    const result = markReviewed(brain, [fs('a', 'b1', 't1')], T1);
    expect(result.advanced).toEqual([]);
    expect(result.brain.entries.get(Path('a'))).toEqual(existing);
  });

  it('leaves a matching internal entry untouched (markKind not promoted, timestamp preserved)', () => {
    const existing = be('a', 'b1', 't1', 'internal', T0);
    const brain = brainOf(existing);
    const result = markReviewed(brain, [fs('a', 'b1', 't1')], T1);
    expect(result.advanced).toEqual([]);
    expect(result.brain.entries.get(Path('a'))).toEqual(existing);
  });

  it('preserves brain entries for paths not mentioned in files', () => {
    const untouched = be('keep', 'kb', 'kt');
    const brain = brainOf(untouched, be('a', 'b1', 't1'));
    const result = markReviewed(brain, [fs('a', 'b1', 't2')], T1);
    expect(result.brain.entries.get(Path('keep'))).toEqual(untouched);
  });

  it('returns an empty result when files is empty', () => {
    const a = be('a', 'b1', 't1');
    const brain = brainOf(a);
    const result = markReviewed(brain, [], T1);
    expect(result.advanced).toEqual([]);
    expect([...result.brain.entries.values()]).toEqual([a]);
  });
});

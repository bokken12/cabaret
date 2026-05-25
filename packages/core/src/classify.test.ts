import { describe, expect, it } from 'vitest';
import { classifyFile, classifyPr, diff4FromBrain } from './classify.js';
import {
  BlobSha,
  type Brain,
  type BrainEntry,
  type FileState,
  Path,
  PrNumber,
  UserId,
} from './types.js';

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

describe('classifyFile', () => {
  it('returns unreviewed when there is no brain entry', () => {
    const current = fs('a', 'b1', 't1');
    expect(classifyFile(undefined, current)).toEqual({
      kind: 'unreviewed',
      path: Path('a'),
      current,
    });
  });

  it('returns reviewed when brain matches the PR exactly', () => {
    expect(classifyFile(be('a', 'b1', 't1'), fs('a', 'b1', 't1'))).toEqual({
      kind: 'reviewed',
      path: Path('a'),
    });
  });

  it('returns revUpdate when the tip is unchanged but the base moved', () => {
    const previous = be('a', 'b1', 't1');
    const current = fs('a', 'b2', 't1');
    expect(classifyFile(previous, current)).toEqual({
      kind: 'revUpdate',
      path: Path('a'),
      current,
      previous,
    });
  });

  it('returns stale when the tip changed', () => {
    const previous = be('a', 'b1', 't1');
    const current = fs('a', 'b1', 't2');
    expect(classifyFile(previous, current)).toEqual({
      kind: 'stale',
      path: Path('a'),
      current,
      previous,
    });
  });

  it('returns stale when both base and tip changed', () => {
    expect(classifyFile(be('a', 'b1', 't1'), fs('a', 'b2', 't2')).kind).toBe('stale');
  });

  it('treats added files (null base) the same way — reviewed when brain matches', () => {
    expect(classifyFile(be('a', null, 't1'), fs('a', null, 't1')).kind).toBe('reviewed');
  });
});

describe('classifyPr', () => {
  it('classifies every file in the PR', () => {
    const reviewed = be('a', 'b1', 't1');
    const stale = be('b', 'b1', 't1');
    const brain: Brain = {
      user: UserId('joel@example.com'),
      pr: PrNumber(42),
      entries: new Map([
        [Path('a'), reviewed],
        [Path('b'), stale],
      ]),
    };
    const changes = [fs('a', 'b1', 't1'), fs('b', 'b1', 't2'), fs('c', null, 't1')];
    expect(classifyPr(brain, changes)).toEqual([
      { kind: 'reviewed', path: Path('a') },
      { kind: 'stale', path: Path('b'), current: changes[1], previous: stale },
      { kind: 'unreviewed', path: Path('c'), current: changes[2] },
    ]);
  });
});

describe('diff4FromBrain', () => {
  it('materializes the four-blob diamond from a brain entry and current state', () => {
    expect(diff4FromBrain(be('a', 'b1', 't1'), fs('a', 'b2', 't2'))).toEqual({
      path: Path('a'),
      oldBase: BlobSha('b1'),
      oldTip: BlobSha('t1'),
      newBase: BlobSha('b2'),
      newTip: BlobSha('t2'),
    });
  });
});

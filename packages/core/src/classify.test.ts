import { describe, expect, it } from 'vitest';
import { classifyFile, classifyPr } from './classify.js';
import {
  BlobSha,
  type BrainEntry,
  type FileState,
  Path,
  PrNumber,
  UserId,
  type Brain,
} from './types.js';

function fs(path: string, base: string | null, tip: string): FileState {
  return {
    path: Path(path),
    baseBlob: base === null ? null : BlobSha(base),
    tipBlob: BlobSha(tip),
  };
}

function be(path: string, base: string | null, tip: string, mark: 'user' | 'internal' = 'user'): BrainEntry {
  return { ...fs(path, base, tip), markKind: mark };
}

describe('classifyFile', () => {
  it('returns unreviewed when there is no brain entry', () => {
    const result = classifyFile(undefined, fs('a', 'b1', 't1'));
    expect(result.kind).toBe('unreviewed');
  });

  it('returns reviewed when brain matches the PR exactly', () => {
    const result = classifyFile(be('a', 'b1', 't1'), fs('a', 'b1', 't1'));
    expect(result.kind).toBe('reviewed');
  });

  it('returns revUpdate when the tip is unchanged but the base moved', () => {
    const result = classifyFile(be('a', 'b1', 't1'), fs('a', 'b2', 't1'));
    expect(result.kind).toBe('revUpdate');
    if (result.kind === 'revUpdate') {
      expect(result.diff4.oldBase).toBe('b1');
      expect(result.diff4.newBase).toBe('b2');
      expect(result.diff4.newTip).toBe('t1');
    }
  });

  it('returns stale when the tip changed', () => {
    const result = classifyFile(be('a', 'b1', 't1'), fs('a', 'b1', 't2'));
    expect(result.kind).toBe('stale');
    if (result.kind === 'stale') {
      expect(result.diff4.oldTip).toBe('t1');
      expect(result.diff4.newTip).toBe('t2');
    }
  });

  it('returns stale when both base and tip changed', () => {
    const result = classifyFile(be('a', 'b1', 't1'), fs('a', 'b2', 't2'));
    expect(result.kind).toBe('stale');
  });

  it('treats new files (null base) the same way — reviewed when brain matches', () => {
    const result = classifyFile(be('a', null, 't1'), fs('a', null, 't1'));
    expect(result.kind).toBe('reviewed');
  });

  it('treats new files as unreviewed when there is no brain entry', () => {
    const result = classifyFile(undefined, fs('a', null, 't1'));
    expect(result.kind).toBe('unreviewed');
  });
});

describe('classifyPr', () => {
  it('classifies every file in the PR', () => {
    const brain: Brain = {
      user: UserId('joel'),
      pr: PrNumber(42),
      entries: new Map([
        [Path('a'), be('a', 'b1', 't1')],
        [Path('b'), be('b', 'b1', 't1')],
      ]),
    };
    const changes = [
      fs('a', 'b1', 't1'), // reviewed
      fs('b', 'b1', 't2'), // stale
      fs('c', null, 't1'), // unreviewed
    ];
    const results = classifyPr(brain, changes);
    expect(results.map((r) => r.kind)).toEqual(['reviewed', 'stale', 'unreviewed']);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  BlobSha,
  type BrainEntry,
  CommitSha,
  type FileState,
  Path,
  PrNumber,
  UserId,
} from '@cabaret/core';
import type { Backend, PrInfo } from '@cabaret/backend';
import { renderReview, runReview, runReviewFile } from './review.js';

const info: PrInfo = {
  number: PrNumber(42),
  title: 'Refactor token bucket',
  author: 'alice',
  baseRef: 'main',
  baseCommit: CommitSha('9a1b2c3'),
  tipCommit: CommitSha('def456'),
  url: 'https://github.com/x/y/pull/42',
};

class FakeBackend implements Backend {
  brain: BrainEntry[];
  writes = 0;
  constructor(
    public readonly changes: readonly FileState[],
    initialBrain: readonly BrainEntry[] = [],
  ) {
    this.brain = [...initialBrain];
  }
  currentUser(): Promise<UserId> {
    return Promise.resolve(UserId('joel@example.com'));
  }
  getPrInfo(): Promise<PrInfo> {
    return Promise.resolve(info);
  }
  getChangedFiles(): Promise<readonly FileState[]> {
    return Promise.resolve(this.changes);
  }
  readBrain(): Promise<readonly BrainEntry[]> {
    return Promise.resolve(this.brain);
  }
  writeBrain(_u: UserId, _p: PrNumber, entries: readonly BrainEntry[]): Promise<void> {
    this.writes += 1;
    this.brain = [...entries];
    return Promise.resolve();
  }
}

function fs(path: string, base: string | null, tip: string): FileState {
  return {
    path: Path(path),
    baseBlob: base === null ? null : BlobSha(base),
    tipBlob: BlobSha(tip),
  };
}

function captureStdout(): { read: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  return { read: () => chunks.join('') };
}

describe('renderReview', () => {
  it('lists advanced paths and reports the count', () => {
    expect(renderReview(info, [Path('a'), Path('b/c')])).toMatchInlineSnapshot(`
      "PR #42 — "Refactor token bucket" by @alice
      tip:  def456
      base: 9a1b2c3 (main)

        reviewed     a
        reviewed     b/c

      2 file(s) reviewed.
      "
    `);
  });

  it('renders the empty case as "nothing to review"', () => {
    expect(renderReview(info, [])).toMatchInlineSnapshot(`
      "PR #42 — "Refactor token bucket" by @alice
      tip:  def456
      base: 9a1b2c3 (main)


      nothing to review.
      "
    `);
  });
});

describe('runReview', () => {
  it('writes user-marked entries for every changed file and prints advanced', async () => {
    const backend = new FakeBackend([fs('a', 'b1', 't1'), fs('b', null, 't2')]);
    const out = captureStdout();
    await runReview(backend, ['42']);
    expect(backend.writes).toBe(1);
    expect(backend.brain).toEqual([
      { path: Path('a'), baseBlob: BlobSha('b1'), tipBlob: BlobSha('t1'), markKind: 'user' },
      { path: Path('b'), baseBlob: null, tipBlob: BlobSha('t2'), markKind: 'user' },
    ]);
    expect(out.read()).toMatchInlineSnapshot(`
      "PR #42 — "Refactor token bucket" by @alice
      tip:  def456
      base: 9a1b2c3 (main)

        reviewed     a
        reviewed     b

      2 file(s) reviewed.
      "
    `);
  });

  it('does not write when the brain is already up to date', async () => {
    const existing: BrainEntry = {
      path: Path('a'),
      baseBlob: BlobSha('b1'),
      tipBlob: BlobSha('t1'),
      markKind: 'user',
    };
    const backend = new FakeBackend([fs('a', 'b1', 't1')], [existing]);
    captureStdout();
    await runReview(backend, ['42']);
    expect(backend.writes).toBe(0);
    expect(backend.brain).toEqual([existing]);
  });

  it('rejects a non-numeric PR argument', async () => {
    const backend = new FakeBackend([]);
    await expect(runReview(backend, ['banana'])).rejects.toThrow(/PR must be a positive integer/);
  });
});

describe('runReviewFile', () => {
  it('advances exactly one path and leaves others untouched', async () => {
    const backend = new FakeBackend([fs('a', 'b1', 't1'), fs('b', null, 't2')]);
    captureStdout();
    await runReviewFile(backend, ['42', 'b']);
    expect(backend.writes).toBe(1);
    expect(backend.brain).toEqual([
      { path: Path('b'), baseBlob: null, tipBlob: BlobSha('t2'), markKind: 'user' },
    ]);
  });

  it('errors when the path is not a changed file in the PR', async () => {
    const backend = new FakeBackend([fs('a', 'b1', 't1')]);
    await expect(runReviewFile(backend, ['42', 'nope.ts'])).rejects.toThrow(
      '"nope.ts" is not a changed file in PR #42',
    );
    expect(backend.writes).toBe(0);
  });

  it('rejects when arguments are missing', async () => {
    const backend = new FakeBackend([]);
    await expect(runReviewFile(backend, ['42'])).rejects.toThrow(
      'usage: cabaret review-file <PR> <path>',
    );
  });

  it('rejects when extra arguments are passed', async () => {
    const backend = new FakeBackend([]);
    await expect(runReviewFile(backend, ['42', 'a', 'b'])).rejects.toThrow(
      'usage: cabaret review-file <PR> <path>',
    );
  });
});

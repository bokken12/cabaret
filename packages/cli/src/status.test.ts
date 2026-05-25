import { describe, expect, it } from 'vitest';
import { BlobSha, CommitSha, type FileStatus, Path, PrNumber } from '@cabaret/core';
import type { PrInfo } from '@cabaret/backend';
import { renderStatus } from './status.js';

const info: PrInfo = {
  number: PrNumber(42),
  title: 'Refactor token bucket',
  author: 'alice',
  baseRef: 'main',
  baseCommit: CommitSha('9a1b2c3'),
  tipCommit: CommitSha('def456'),
  url: 'https://github.com/x/y/pull/42',
};

describe('renderStatus', () => {
  it('shows zero attention when everything is reviewed', () => {
    const statuses: FileStatus[] = [
      { kind: 'reviewed', path: Path('a') },
      { kind: 'reviewed', path: Path('b') },
    ];
    const out = renderStatus(info, statuses);
    expect(out).toContain('0 of 2 file(s) need attention');
  });

  it('counts stale and unreviewed as attention-needing; rev-update too', () => {
    const statuses: FileStatus[] = [
      { kind: 'reviewed', path: Path('a') },
      {
        kind: 'stale',
        path: Path('b'),
        diff4: {
          path: Path('b'),
          oldBase: BlobSha('1'),
          oldTip: BlobSha('2'),
          newBase: BlobSha('1'),
          newTip: BlobSha('3'),
        },
      },
      {
        kind: 'unreviewed',
        path: Path('c'),
        diff2: { path: Path('c'), baseBlob: null, tipBlob: BlobSha('4') },
      },
      {
        kind: 'revUpdate',
        path: Path('d'),
        diff4: {
          path: Path('d'),
          oldBase: BlobSha('1'),
          oldTip: BlobSha('5'),
          newBase: BlobSha('2'),
          newTip: BlobSha('5'),
        },
      },
    ];
    const out = renderStatus(info, statuses);
    expect(out).toContain('3 of 4 file(s) need attention');
    expect(out).toContain('rev-update');
    expect(out).toContain('stale');
    expect(out).toContain('unreviewed');
  });

  it('handles an empty PR', () => {
    expect(renderStatus(info, [])).toContain('no changed files');
  });
});

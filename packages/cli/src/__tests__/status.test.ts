import { describe, expect, it } from 'vitest';
import { BlobSha, CommitSha, type FileStatus, Path, PrNumber } from '@cabaret/core';
import type { PrInfo } from '@cabaret/backend';
import { renderStatus } from '../status.js';

const info: PrInfo = {
  number: PrNumber(42),
  title: 'Refactor token bucket',
  author: 'alice',
  baseRef: 'main',
  baseCommit: CommitSha('9a1b2c3'),
  tipCommit: CommitSha('def456'),
  url: 'https://github.com/x/y/pull/42',
};

const previousReviewed = {
  path: Path('a'),
  baseBlob: BlobSha('b1'),
  tipBlob: BlobSha('t1'),
  markKind: 'user' as const,
};

describe('renderStatus', () => {
  it('renders a fully-reviewed PR', () => {
    const statuses: FileStatus[] = [
      { kind: 'reviewed', path: Path('a') },
      { kind: 'reviewed', path: Path('b') },
    ];
    expect(renderStatus(info, statuses)).toMatchInlineSnapshot(`
      "PR #42 — "Refactor token bucket" by @alice
      tip:  def456
      base: 9a1b2c3 (main)

        reviewed     a
        reviewed     b

      0 of 2 file(s) need attention.
      "
    `);
  });

  it('renders every status kind with the right label and attention count', () => {
    const statuses: FileStatus[] = [
      { kind: 'reviewed', path: Path('a') },
      {
        kind: 'stale',
        path: Path('b'),
        current: { path: Path('b'), baseBlob: BlobSha('1'), tipBlob: BlobSha('3') },
        previous: previousReviewed,
      },
      {
        kind: 'unreviewed',
        path: Path('c'),
        current: { path: Path('c'), baseBlob: null, tipBlob: BlobSha('4') },
      },
      {
        kind: 'revUpdate',
        path: Path('d'),
        current: { path: Path('d'), baseBlob: BlobSha('2'), tipBlob: BlobSha('5') },
        previous: { ...previousReviewed, path: Path('d'), tipBlob: BlobSha('5') },
      },
    ];
    expect(renderStatus(info, statuses)).toMatchInlineSnapshot(`
      "PR #42 — "Refactor token bucket" by @alice
      tip:  def456
      base: 9a1b2c3 (main)

        reviewed     a
        stale        b
        unreviewed   c
        rev-update   d

      3 of 4 file(s) need attention.
      "
    `);
  });

  it('renders an empty PR', () => {
    expect(renderStatus(info, [])).toMatchInlineSnapshot(`
      "PR #42 — "Refactor token bucket" by @alice
      tip:  def456
      base: 9a1b2c3 (main)


      no changed files.
      "
    `);
  });
});

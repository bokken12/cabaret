import { describe, expect, it } from 'vitest';
import { parseBrainFile, parseRepoSlug } from './local-git.js';
import { parseDiffTreeRaw } from './git.js';
import { parseGhPrView } from './gh.js';
import { BlobSha, Path, type BrainEntry } from '@cabaret/core';

describe('parseRepoSlug', () => {
  // TODO: replace with property-based tests over a generator of well-formed
  // remote URLs once we add fast-check.
  it.each([
    ['SSH', 'git@github.com:torvalds/linux.git', { owner: 'torvalds', name: 'linux' }],
    ['HTTPS with .git', 'https://github.com/facebook/react.git', { owner: 'facebook', name: 'react' }],
    ['HTTPS without .git', 'https://github.com/sindresorhus/p-queue', { owner: 'sindresorhus', name: 'p-queue' }],
    ['SSH with hyphenated org', 'git@github.com:jestjs/jest.git', { owner: 'jestjs', name: 'jest' }],
  ])('parses %s remotes', (_label, url, expected) => {
    expect(parseRepoSlug(url)).toEqual(expected);
  });

  it.each([
    ['gitlab', 'git@gitlab.com:foo/bar.git'],
    ['bitbucket', 'git@bitbucket.org:foo/bar.git'],
    ['file path', '/local/path/repo'],
  ])('rejects non-GitHub remotes (%s)', (_label, url) => {
    expect(() => parseRepoSlug(url)).toThrow();
  });
});

describe('brain file round-trip', () => {
  it('serialize → parse preserves the original entries', () => {
    const original: readonly BrainEntry[] = [
      { path: Path('src/foo.rs'), baseBlob: BlobSha('b1'), tipBlob: BlobSha('t1'), markKind: 'user' },
      { path: Path('src/bar.rs'), baseBlob: null, tipBlob: BlobSha('t2'), markKind: 'internal' },
    ];
    const serialized = JSON.stringify({
      schema: 1,
      pr: 42,
      user: 'joel@example.com',
      entries: original,
    });
    expect(parseBrainFile(serialized)).toEqual(original);
  });

  it('rejects unknown schema versions', () => {
    expect(() => parseBrainFile(JSON.stringify({ schema: 2, pr: 1, user: 'x', entries: [] }))).toThrow();
  });

  it('rejects entries with the wrong shape', () => {
    expect(() =>
      parseBrainFile(
        JSON.stringify({
          schema: 1,
          pr: 1,
          user: 'x',
          entries: [{ path: 'a', tipBlob: 't', markKind: 'user' }], // baseBlob missing
        }),
      ),
    ).toThrow();
  });
});

describe('parseDiffTreeRaw', () => {
  it('parses a modified file', () => {
    const raw = ':100644 100644 abc123 def456 M\0src/foo.rs\0';
    expect(parseDiffTreeRaw(raw)).toEqual([
      { path: Path('src/foo.rs'), baseBlob: BlobSha('abc123'), tipBlob: BlobSha('def456') },
    ]);
  });

  it('surfaces an added file (all-zero old SHA) as null baseBlob', () => {
    const raw = ':000000 100644 0000000000000000000000000000000000000000 def456 A\0new/file.ts\0';
    expect(parseDiffTreeRaw(raw)).toEqual([
      { path: Path('new/file.ts'), baseBlob: null, tipBlob: BlobSha('def456') },
    ]);
  });

  it('parses a multi-file diff', () => {
    const raw = [
      ':100644 100644 a1 b1 M\0a.ts\0',
      ':000000 100644 0000000 b2 A\0b.ts\0',
      ':100644 100644 a3 b3 M\0sub/c.ts\0',
    ].join('');
    expect(parseDiffTreeRaw(raw)).toEqual([
      { path: Path('a.ts'), baseBlob: BlobSha('a1'), tipBlob: BlobSha('b1') },
      { path: Path('b.ts'), baseBlob: null, tipBlob: BlobSha('b2') },
      { path: Path('sub/c.ts'), baseBlob: BlobSha('a3'), tipBlob: BlobSha('b3') },
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(parseDiffTreeRaw('')).toEqual([]);
  });
});

describe('parseGhPrView', () => {
  // TODO: a CABARET_INTEGRATION=1-gated test could shell out to the real
  // `gh` against a known public PR to detect format drift in gh's output.
  it('parses a well-formed response', () => {
    const raw = JSON.stringify({
      number: 7,
      title: 'Drop legacy adapter',
      author: { login: 'kelsey' },
      baseRefName: 'develop',
      baseRefOid: 'a1b2c3',
      headRefName: 'kelsey/drop-adapter',
      headRefOid: 'd4e5f6',
      url: 'https://github.com/torvalds/linux/pull/7',
    });
    expect(parseGhPrView(raw)).toEqual({
      number: 7,
      title: 'Drop legacy adapter',
      author: { login: 'kelsey' },
      baseRefName: 'develop',
      baseRefOid: 'a1b2c3',
      headRefName: 'kelsey/drop-adapter',
      headRefOid: 'd4e5f6',
      url: 'https://github.com/torvalds/linux/pull/7',
    });
  });

  it('rejects responses missing required fields', () => {
    expect(() => parseGhPrView(JSON.stringify({ number: 42 }))).toThrow();
  });
});

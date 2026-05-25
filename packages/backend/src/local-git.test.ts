import { describe, expect, it } from 'vitest';
import { parseBrainFile, parseRepoSlug } from './local-git.js';
import { parseDiffTreeRaw } from './git.js';
import { parseGhPrView } from './gh.js';

describe('parseRepoSlug', () => {
  it('parses SSH remote URLs', () => {
    expect(parseRepoSlug('git@github.com:bokken12/cabaret.git')).toEqual({
      owner: 'bokken12',
      name: 'cabaret',
    });
  });

  it('parses HTTPS remote URLs', () => {
    expect(parseRepoSlug('https://github.com/bokken12/cabaret.git')).toEqual({
      owner: 'bokken12',
      name: 'cabaret',
    });
  });

  it('parses HTTPS URLs without .git suffix', () => {
    expect(parseRepoSlug('https://github.com/bokken12/cabaret')).toEqual({
      owner: 'bokken12',
      name: 'cabaret',
    });
  });

  it('throws on non-GitHub URLs', () => {
    expect(() => parseRepoSlug('git@gitlab.com:foo/bar.git')).toThrow();
  });
});

describe('parseBrainFile', () => {
  it('round-trips entries', () => {
    const raw = JSON.stringify({
      schema: 1,
      pr: 42,
      user: 'joel',
      entries: [
        { path: 'src/foo.rs', baseBlob: 'b1', tipBlob: 't1', markKind: 'user' },
        { path: 'src/bar.rs', baseBlob: null, tipBlob: 't2', markKind: 'internal' },
      ],
    });
    const entries = parseBrainFile(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.baseBlob).toBe('b1');
    expect(entries[1]?.baseBlob).toBeNull();
    expect(entries[1]?.markKind).toBe('internal');
  });

  it('rejects unknown schema versions', () => {
    expect(() => parseBrainFile(JSON.stringify({ schema: 2, entries: [] }))).toThrow();
  });
});

describe('parseDiffTreeRaw', () => {
  it('handles modified files', () => {
    const raw = ':100644 100644 abc123 def456 M\0src/foo.rs\0';
    const out = parseDiffTreeRaw(raw);
    expect(out).toHaveLength(1);
    expect(out[0]?.path).toBe('src/foo.rs');
    expect(out[0]?.baseBlob).toBe('abc123');
    expect(out[0]?.tipBlob).toBe('def456');
  });

  it('treats all-zero old SHAs (added files) as null baseBlob', () => {
    const raw = ':000000 100644 0000000000000000000000000000000000000000 def456 A\0new/file.ts\0';
    const out = parseDiffTreeRaw(raw);
    expect(out[0]?.baseBlob).toBeNull();
    expect(out[0]?.tipBlob).toBe('def456');
  });

  it('returns an empty array for empty input', () => {
    expect(parseDiffTreeRaw('')).toEqual([]);
  });
});

describe('parseGhPrView', () => {
  it('parses a normal response', () => {
    const raw = JSON.stringify({
      number: 42,
      title: 'Refactor',
      author: { login: 'alice' },
      baseRefName: 'main',
      baseRefOid: 'b1',
      headRefName: 'feature',
      headRefOid: 't1',
      url: 'https://github.com/o/r/pull/42',
    });
    const view = parseGhPrView(raw);
    expect(view.number).toBe(42);
    expect(view.author.login).toBe('alice');
    expect(view.headRefOid).toBe('t1');
  });

  it('rejects missing fields', () => {
    expect(() => parseGhPrView(JSON.stringify({ number: 42 }))).toThrow();
  });
});

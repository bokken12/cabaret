import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  brainRefName,
  LocalGitBackend,
  parseBrainBlob,
  serializeBrainBlob,
} from '../local-git.js';
import { parseDiffTreeRaw } from '../git.js';
import { parseGhPrView } from '../gh.js';
import {
  BlobSha,
  type BrainEntry,
  Path,
  PrNumber,
  Timestamp,
  UserId,
} from '@cabaret/core';

const execFileAsync = promisify(execFile);

describe('brainRefName', () => {
  it.each([
    ['plain email', 'alice@example.com', 42, 'refs/cabaret/users/alice@example.com/prs/42'],
    [
      'plus-tag, dots, hyphens',
      'alice.b+ci@test-org.dev',
      7,
      'refs/cabaret/users/alice.b+ci@test-org.dev/prs/7',
    ],
  ])('builds the expected ref for %s', (_label, user, pr, expected) => {
    expect(brainRefName(UserId(user), PrNumber(pr))).toBe(expected);
  });

  it.each([
    ['slash', 'a/b'],
    ['whitespace', 'weird name'],
    ['colon', 'a:b'],
    ['leading dot', '.foo@bar'],
    ['trailing dot', 'foo@bar.'],
    ['double dot', 'a..b@bar'],
    ['ends with .lock', 'foo@bar.lock'],
    ['empty', ''],
    ['lone @', '@'],
  ])('throws on UserId with %s', (_label, user) => {
    expect(() => brainRefName(UserId(user), PrNumber(1))).toThrow(/safe to use in a git ref/);
  });
});

describe('brain blob round-trip', () => {
  const entries: readonly BrainEntry[] = [
    {
      path: Path('src/foo.rs'),
      baseBlob: BlobSha('b1'),
      tipBlob: BlobSha('t1'),
      markKind: 'user',
      lastModifiedAt: Timestamp(1_700_000_000_000),
    },
    {
      path: Path('src/bar.rs'),
      baseBlob: null,
      tipBlob: BlobSha('t2'),
      markKind: 'internal',
      lastModifiedAt: Timestamp(1_700_000_001_000),
    },
  ];

  it('serialize → parse preserves the original entries', () => {
    const raw = serializeBrainBlob(UserId('alice@example.com'), PrNumber(42), entries);
    expect(parseBrainBlob(raw)).toEqual(entries);
  });

  it('serializes to a stable, pretty-printed payload', () => {
    expect(serializeBrainBlob(UserId('alice@example.com'), PrNumber(42), entries))
      .toMatchInlineSnapshot(`
        "{
          "schema": 1,
          "pr": 42,
          "user": "alice@example.com",
          "entries": [
            {
              "path": "src/foo.rs",
              "baseBlob": "b1",
              "tipBlob": "t1",
              "markKind": "user",
              "lastModifiedAt": 1700000000000
            },
            {
              "path": "src/bar.rs",
              "baseBlob": null,
              "tipBlob": "t2",
              "markKind": "internal",
              "lastModifiedAt": 1700000001000
            }
          ]
        }
        "
      `);
  });

  it('rejects payloads with the wrong schema version', () => {
    expect(() => parseBrainBlob(JSON.stringify({ schema: 2, pr: 1, user: 'x', entries: [] })))
      .toThrow();
  });

  it('rejects entries missing lastModifiedAt', () => {
    expect(() =>
      parseBrainBlob(
        JSON.stringify({
          schema: 1,
          pr: 1,
          user: 'x',
          entries: [{ path: 'a', baseBlob: null, tipBlob: 't', markKind: 'user' }],
        }),
      ),
    ).toThrow();
  });
});

describe('LocalGitBackend brain storage', () => {
  let repo: string;
  let backend: LocalGitBackend;

  const user = UserId('alice@example.com');
  const pr = PrNumber(42);

  async function git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: repo });
    return stdout;
  }

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cabaret-brain-'));
    await execFileAsync('git', ['init', '--initial-branch=main', repo]);
    // Configure committer identity so commit-tree accepts our calls.
    await git('config', 'user.email', user);
    await git('config', 'user.name', 'Alice Test');
    backend = new LocalGitBackend({ cwd: repo });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('returns [] when no ref exists', async () => {
    expect(await backend.readBrain(user, pr)).toEqual([]);
  });

  it('round-trips entries through the ref', async () => {
    const entries: readonly BrainEntry[] = [
      {
        path: Path('a.ts'),
        baseBlob: BlobSha('aaa'),
        tipBlob: BlobSha('bbb'),
        markKind: 'user',
        lastModifiedAt: Timestamp(1_700_000_000_000),
      },
      {
        path: Path('b.ts'),
        baseBlob: null,
        tipBlob: BlobSha('ccc'),
        markKind: 'internal',
        lastModifiedAt: Timestamp(1_700_000_001_000),
      },
    ];
    await backend.writeBrain(user, pr, entries);
    expect(await backend.readBrain(user, pr)).toEqual(entries);
  });

  it('parents each new commit on the previous one (history is preserved)', async () => {
    const e1: BrainEntry = {
      path: Path('a.ts'),
      baseBlob: BlobSha('aaa'),
      tipBlob: BlobSha('bbb'),
      markKind: 'user',
      lastModifiedAt: Timestamp(1_700_000_000_000),
    };
    const e2: BrainEntry = { ...e1, tipBlob: BlobSha('ccc'), lastModifiedAt: Timestamp(1_700_000_002_000) };
    await backend.writeBrain(user, pr, [e1]);
    await backend.writeBrain(user, pr, [e2]);
    const log = await git('log', '--format=%H %P', brainRefName(user, pr));
    const lines = log.trim().split('\n');
    expect(lines).toHaveLength(2);
    const [tipLine, rootLine] = lines;
    if (tipLine === undefined || rootLine === undefined) throw new Error('unreachable');
    const tip = tipLine.split(' ');
    const root = rootLine.split(' ');
    // tip line: "<commitOID> <parentOID>"; root line: "<commitOID>" (no parent)
    expect(tip).toHaveLength(2);
    expect(root).toHaveLength(1);
    expect(tip[1]).toBe(root[0]);
  });

  it('stores the payload as brain.json in the commit tree', async () => {
    const entry: BrainEntry = {
      path: Path('a.ts'),
      baseBlob: BlobSha('aaa'),
      tipBlob: BlobSha('bbb'),
      markKind: 'user',
      lastModifiedAt: Timestamp(1_700_000_000_000),
    };
    await backend.writeBrain(user, pr, [entry]);
    const tree = await git('ls-tree', '--name-only', brainRefName(user, pr));
    expect(tree.trim().split('\n')).toEqual(['brain.json']);
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

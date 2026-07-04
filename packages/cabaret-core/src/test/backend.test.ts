import fc from "fast-check";
import { expect, test } from "vitest";
import { ZodError } from "zod";
import {
  brain,
  type CommitHash,
  currentBase,
  currentOwner,
  currentParent,
  type FilePath,
  formatLogEntry,
  type LogAction,
  type LogEntry,
  parseCommitHash,
  parseFilePath,
  parseLog,
  parseRefName,
  type RefName,
  type TimestampMs,
  timestampMs,
  type UserName,
  userName,
} from "../index.js";

const SHA1 = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA1 = "fedcba9876543210fedcba9876543210fedcba98";
const SHA256 = SHA1 + SHA1.slice(0, 24);

test("parses full sha1 and sha256 hashes", () => {
  expect(parseCommitHash(SHA1)).toBe(SHA1);
  expect(parseCommitHash(SHA256)).toBe(SHA256);
});

test("rejects anything else", () => {
  for (const bad of ["", "HEAD", SHA1.slice(0, 7), SHA1.toUpperCase(), `${SHA1}\n`]) {
    expect(() => parseCommitHash(bad)).toThrow("not a commit hash");
  }
});

test("parses ordinary file paths", () => {
  for (const ok of ["README.md", "src/backend.ts", "with space.txt", "weird~^:?.name"]) {
    expect(parseFilePath(ok)).toBe(ok);
  }
});

test("rejects empty and NUL-containing file paths", () => {
  for (const bad of ["", "nul\0byte"]) {
    expect(() => parseFilePath(bad)).toThrow("not a valid file path");
  }
});

test("parses ordinary branch and ref names", () => {
  for (const ok of ["main", "feature/foo", "release-1.2", "refs/heads/main"]) {
    expect(parseRefName(ok)).toBe(ok);
  }
});

test("rejects malformed ref names", () => {
  for (const bad of [
    "",
    "has space",
    "foo..bar",
    "foo~1",
    "foo:bar",
    "foo^",
    "foo?",
    "foo*",
    "foo\\bar",
    "@",
    "foo@{0}",
    "/leading",
    "double//slash",
    "trailing.",
    "foo.lock",
    "line\nbreak",
  ]) {
    expect(() => parseRefName(bad)).toThrow("not a valid ref name");
  }
});

test("formatLogEntry renders one JSON object per line, keys in schema order", () => {
  expect(
    formatLogEntry({
      // Key order here deliberately differs from the schema's.
      action: { parent: parseRefName("main"), kind: "set-parent" },
      user: userName("alice@example.com"),
      timestamp: timestampMs(1748000000000),
    }),
  ).toBe('{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n');
});

test("formatLogEntry renders review and forget actions", () => {
  expect(
    formatLogEntry({
      timestamp: timestampMs(1748000000001),
      user: userName("bob@example.com"),
      // Key order here deliberately differs from the schema's.
      action: {
        tip: parseCommitHash(SHA256),
        base: parseCommitHash(SHA1),
        file: parseFilePath("src/backend.ts"),
        kind: "review",
      },
    }),
  ).toBe(
    `{"timestamp":1748000000001,"user":"bob@example.com","action":{"kind":"review","file":"src/backend.ts","base":"${SHA1}","tip":"${SHA256}"}}\n`,
  );
  expect(
    formatLogEntry({
      timestamp: timestampMs(1748000000002),
      user: userName("carol@example.com"),
      action: { kind: "forget", file: parseFilePath("docs/log.md") },
    }),
  ).toBe('{"timestamp":1748000000002,"user":"carol@example.com","action":{"kind":"forget","file":"docs/log.md"}}\n');
});

test("formatLogEntry renders set-base actions", () => {
  expect(
    formatLogEntry({
      timestamp: timestampMs(1748000000003),
      user: userName("dave@example.com"),
      action: { kind: "set-base", base: parseCommitHash(OTHER_SHA1) },
    }),
  ).toBe(`{"timestamp":1748000000003,"user":"dave@example.com","action":{"kind":"set-base","base":"${OTHER_SHA1}"}}\n`);
});

test("formatLogEntry renders set-owner actions", () => {
  expect(
    formatLogEntry({
      timestamp: timestampMs(1748000000004),
      user: userName("erin@example.com"),
      action: { kind: "set-owner", owner: userName("frank@example.com") },
    }),
  ).toBe(
    '{"timestamp":1748000000004,"user":"erin@example.com","action":{"kind":"set-owner","owner":"frank@example.com"}}\n',
  );
});

test("timestampMs rejects non-integers, negatives, and unsafe integers", () => {
  for (const bad of [0.5, -1, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => timestampMs(bad)).toThrow("not a millisecond timestamp");
  }
});

test("formatLogEntry rejects invalid timestamps and users", () => {
  const entry = {
    timestamp: timestampMs(1748000060000),
    user: userName("bob@example.com"),
    action: { kind: "set-parent", parent: parseRefName("feature/base") },
  } as const;
  for (const bad of [0.5, -1, 2 ** 53]) {
    expect(() => formatLogEntry({ ...entry, timestamp: bad as TimestampMs })).toThrow("not a millisecond timestamp");
  }
  expect(() => formatLogEntry({ ...entry, user: userName("") })).toThrow(ZodError);
});

test("a formatted log parses back to the original entries", () => {
  const entries: LogEntry[] = [
    {
      timestamp: timestampMs(1748000000000),
      user: userName("alice@example.com"),
      action: { kind: "set-parent", parent: parseRefName("main") },
    },
    {
      timestamp: timestampMs(1748000060000),
      user: userName('Bob Smith <bob@example.com>\n"tricky"'),
      action: { kind: "set-parent", parent: parseRefName("feature/base") },
    },
    {
      timestamp: timestampMs(1748000120000),
      user: userName("carol@example.com"),
      action: {
        kind: "review",
        file: parseFilePath("src/with space.ts"),
        base: parseCommitHash(OTHER_SHA1),
        tip: parseCommitHash(SHA1),
      },
    },
    {
      timestamp: timestampMs(1748000180000),
      user: userName("bob@example.com"),
      action: { kind: "forget", file: parseFilePath("README.md") },
    },
    {
      timestamp: timestampMs(1748000240000),
      user: userName("dave@example.com"),
      action: { kind: "set-base", base: parseCommitHash(SHA256) },
    },
    {
      timestamp: timestampMs(1748000300000),
      user: userName("dave@example.com"),
      action: { kind: "set-owner", owner: userName("erin@example.com") },
    },
  ];
  expect(parseLog(entries.map(formatLogEntry).join(""))).toEqual(entries);
});

test("the empty log parses to no entries", () => {
  expect(parseLog("")).toEqual([]);
});

test("parseLog rejects malformed logs", () => {
  const line = (fields: object) => `${JSON.stringify(fields)}\n`;
  const entry = {
    timestamp: 1748000000000,
    user: "alice@example.com",
    action: { kind: "set-parent", parent: "main" },
  };
  const cases: [string, string][] = [
    [JSON.stringify(entry), "missing trailing newline"],
    ["not a log line\n", "malformed log line"],
    [line({ timestamp: entry.timestamp, user: entry.user }), "malformed log line"],
    [line({ ...entry, timestamp: 1e20 }), "malformed log line"],
    [line({ ...entry, user: "" }), "malformed log line"],
    [line({ ...entry, action: { kind: "merge", parent: "main" } }), "malformed log line"],
    [line({ ...entry, action: { kind: "set-parent", parent: "bad..ref" } }), "malformed log line"],
    [line({ ...entry, action: { kind: "review", file: "a.ts", base: SHA1, tip: "HEAD" } }), "malformed log line"],
    [line({ ...entry, action: { kind: "review", file: "a.ts", tip: SHA1 } }), "malformed log line"],
    [line({ ...entry, action: { kind: "forget", file: "" } }), "malformed log line"],
    [line({ ...entry, action: { kind: "set-base", base: "main" } }), "malformed log line"],
    [line({ ...entry, action: { kind: "set-base" } }), "malformed log line"],
    [line({ ...entry, action: { kind: "set-owner", owner: "" } }), "malformed log line"],
    [line({ ...entry, action: { kind: "set-owner" } }), "malformed log line"],
  ];
  for (const [log, error] of cases) {
    expect(() => parseLog(log)).toThrow(error);
  }
});

test("currentParent takes the set-parent with the greatest timestamp, regardless of order", () => {
  const entry = (timestamp: number, action: LogAction): LogEntry => ({
    timestamp: timestampMs(timestamp),
    user: userName("alice@example.com"),
    action,
  });
  const change = parseRefName("feature");
  expect(() => currentParent(change, [])).toThrow('change has no parent: "feature"');
  expect(() => currentParent(change, [entry(5, { kind: "forget", file: parseFilePath("a.ts") })])).toThrow(
    'change has no parent: "feature"',
  );
  expect(
    currentParent(change, [
      entry(9, { kind: "set-parent", parent: parseRefName("newest") }),
      entry(3, { kind: "set-parent", parent: parseRefName("oldest") }),
      entry(12, {
        kind: "review",
        file: parseFilePath("a.ts"),
        base: parseCommitHash(OTHER_SHA1),
        tip: parseCommitHash(SHA1),
      }),
    ]),
  ).toBe("newest");
});

test("currentBase takes the set-base with the greatest timestamp, regardless of order", () => {
  const entry = (timestamp: number, action: LogAction): LogEntry => ({
    timestamp: timestampMs(timestamp),
    user: userName("alice@example.com"),
    action,
  });
  const change = parseRefName("feature");
  expect(() => currentBase(change, [])).toThrow('change has no base: "feature"');
  expect(() => currentBase(change, [entry(5, { kind: "set-parent", parent: parseRefName("main") })])).toThrow(
    'change has no base: "feature"',
  );
  expect(
    currentBase(change, [
      entry(9, { kind: "set-base", base: parseCommitHash(SHA256) }),
      entry(3, { kind: "set-base", base: parseCommitHash(SHA1) }),
      entry(12, {
        kind: "review",
        file: parseFilePath("a.ts"),
        base: parseCommitHash(OTHER_SHA1),
        tip: parseCommitHash(SHA1),
      }),
    ]),
  ).toBe(SHA256);
});

test("currentOwner takes the set-owner with the greatest timestamp, regardless of order", () => {
  const entry = (timestamp: number, action: LogAction): LogEntry => ({
    timestamp: timestampMs(timestamp),
    user: userName("alice@example.com"),
    action,
  });
  const change = parseRefName("feature");
  expect(() => currentOwner(change, [])).toThrow('change has no owner: "feature"');
  expect(() => currentOwner(change, [entry(5, { kind: "set-parent", parent: parseRefName("main") })])).toThrow(
    'change has no owner: "feature"',
  );
  expect(
    currentOwner(change, [
      entry(9, { kind: "set-owner", owner: userName("carol@example.com") }),
      entry(3, { kind: "set-owner", owner: userName("bob@example.com") }),
      entry(12, { kind: "set-parent", parent: parseRefName("main") }),
    ]),
  ).toBe("carol@example.com");
});

test("brain keeps each file's latest review per user and honors forgets by timestamp", () => {
  const alice = userName("alice@example.com");
  const bob = userName("bob@example.com");
  const at = (timestamp: number, user: UserName, action: LogAction): LogEntry => ({
    timestamp: timestampMs(timestamp),
    user,
    action,
  });
  const review = (file: string, base: string, tip: string): LogAction => ({
    kind: "review",
    file: parseFilePath(file),
    base: parseCommitHash(base),
    tip: parseCommitHash(tip),
  });
  const entries: LogEntry[] = [
    at(1, alice, review("a.ts", SHA1, OTHER_SHA1)),
    at(4, alice, review("a.ts", SHA1, SHA256)),
    // This forget precedes its file's review in the log but wins by timestamp.
    at(9, alice, { kind: "forget", file: parseFilePath("b.ts") }),
    at(2, alice, review("b.ts", OTHER_SHA1, SHA1)),
    at(3, alice, review("c.ts", SHA1, SHA1)),
    at(8, bob, { kind: "forget", file: parseFilePath("a.ts") }),
    at(5, alice, { kind: "set-parent", parent: parseRefName("main") }),
    at(10, alice, { kind: "set-base", base: parseCommitHash(SHA256) }),
    // Equal timestamps: the entry later in the log wins.
    at(6, alice, review("d.ts", SHA1, OTHER_SHA1)),
    at(6, alice, { kind: "forget", file: parseFilePath("d.ts") }),
    at(7, alice, { kind: "forget", file: parseFilePath("e.ts") }),
    at(7, alice, review("e.ts", OTHER_SHA1, SHA256)),
  ];
  expect(brain(entries, alice)).toEqual(
    new Map([
      [parseFilePath("a.ts"), { base: SHA1, tip: SHA256 }],
      [parseFilePath("c.ts"), { base: SHA1, tip: SHA1 }],
      [parseFilePath("e.ts"), { base: OTHER_SHA1, tip: SHA256 }],
    ]),
  );
  expect(brain(entries, bob)).toEqual(new Map());
  expect(brain([], alice)).toEqual(new Map());
});

function refNames(): fc.Arbitrary<RefName> {
  const valid = (raw: string): boolean => {
    try {
      parseRefName(raw);
      return true;
    } catch {
      return false;
    }
  };
  return fc.string({ minLength: 1, maxLength: 30 }).filter(valid).map(parseRefName);
}

function filePaths(): fc.Arbitrary<FilePath> {
  return fc
    .string({ minLength: 1, unit: "grapheme" })
    .filter((raw) => !raw.includes("\0"))
    .map(parseFilePath);
}

function commitHashes(): fc.Arbitrary<CommitHash> {
  return fc.string({ unit: fc.constantFrom(..."0123456789abcdef"), minLength: 40, maxLength: 40 }).map(parseCommitHash);
}

function logActions(): fc.Arbitrary<LogAction> {
  const users = fc.string({ minLength: 1, unit: "grapheme" }).map(userName);
  return fc.oneof(
    fc.record({ kind: fc.constant("set-parent" as const), parent: refNames() }),
    fc.record({ kind: fc.constant("set-base" as const), base: commitHashes() }),
    fc.record({ kind: fc.constant("set-owner" as const), owner: users }),
    fc.record({ kind: fc.constant("review" as const), file: filePaths(), base: commitHashes(), tip: commitHashes() }),
    fc.record({ kind: fc.constant("forget" as const), file: filePaths() }),
  );
}

function logEntries(): fc.Arbitrary<LogEntry> {
  return fc.record({
    timestamp: fc.maxSafeNat().map(timestampMs),
    user: fc.string({ minLength: 1, unit: "grapheme" }).map(userName),
    action: logActions(),
  });
}

test("format/parse round-trips arbitrary logs", () => {
  fc.assert(
    fc.property(fc.array(logEntries()), (entries) => {
      expect(parseLog(entries.map(formatLogEntry).join(""))).toEqual(entries);
    }),
  );
});

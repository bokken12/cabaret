import fc from "fast-check";
import { expect, test } from "vitest";
import { ZodError } from "zod";
import {
  assertNotLanded,
  type Backend,
  brain,
  type CommitHash,
  currentBase,
  currentOwner,
  currentParent,
  type FilePath,
  forgeRequestId,
  formatLogEntry,
  type LandMerge,
  type LogAction,
  type LogEntry,
  landedMerge,
  parseCommitHash,
  parseFilePath,
  parseForgeLocator,
  parseLog,
  parseRefName,
  type RefName,
  reviewSegments,
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

test("formatLogEntry renders land actions", () => {
  expect(
    formatLogEntry({
      timestamp: timestampMs(1748000000005),
      user: userName("grace@example.com"),
      action: { kind: "land", merge: parseCommitHash(SHA1) },
    }),
  ).toBe(`{"timestamp":1748000000005,"user":"grace@example.com","action":{"kind":"land","merge":"${SHA1}"}}\n`);
});

test("formatLogEntry renders comment actions, escaping newlines", () => {
  expect(
    formatLogEntry({
      timestamp: timestampMs(1748000000006),
      user: userName("heidi@example.com"),
      action: { kind: "comment", text: "looks good\nbut rename the flag" },
    }),
  ).toBe(
    '{"timestamp":1748000000006,"user":"heidi@example.com","action":{"kind":"comment","text":"looks good\\nbut rename the flag"}}\n',
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
    {
      timestamp: timestampMs(1748000360000),
      user: userName("grace@example.com"),
      action: { kind: "land", merge: parseCommitHash(SHA256) },
    },
    {
      timestamp: timestampMs(1748000420000),
      user: userName("heidi@example.com"),
      action: { kind: "comment", text: 'multi\nline "comment"\n' },
    },
    {
      timestamp: timestampMs(1748000480000),
      user: userName("erin@example.com"),
      action: {
        kind: "set-forge",
        forge: parseForgeLocator("github.com/test-org/widgets"),
        request: forgeRequestId(7),
      },
    },
    {
      timestamp: timestampMs(1748000540000),
      user: userName("carol@users.noreply.github.com"),
      action: {
        kind: "comment",
        text: "imported",
        source: { forge: parseForgeLocator("github.com/test-org/widgets"), id: "3025" },
      },
    },
    {
      timestamp: timestampMs(1748000600000),
      user: userName("carol@users.noreply.github.com"),
      action: {
        kind: "comment",
        text: "imported (edited)",
        source: { forge: parseForgeLocator("github.com/test-org/widgets"), id: "3025", edits: "ab".repeat(32) },
      },
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
    [line({ ...entry, action: { kind: "land", merge: "HEAD" } }), "malformed log line"],
    [line({ ...entry, action: { kind: "land" } }), "malformed log line"],
    [line({ ...entry, action: { kind: "comment", text: "" } }), "malformed log line"],
    [line({ ...entry, action: { kind: "comment" } }), "malformed log line"],
    [line({ ...entry, action: { kind: "comment", text: "hi", source: { forge: "", id: "1" } } }), "malformed log line"],
    [
      line({ ...entry, action: { kind: "comment", text: "hi", source: { forge: "gh.test/a/b" } } }),
      "malformed log line",
    ],
    [line({ ...entry, action: { kind: "set-forge", forge: "gh.test/a/b", request: 0 } }), "malformed log line"],
    [line({ ...entry, action: { kind: "set-forge", forge: "gh.test/a/b", request: 1.5 } }), "malformed log line"],
    [line({ ...entry, action: { kind: "set-forge", request: 1 } }), "malformed log line"],
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
  expect(() => currentParent(change, [])).toThrow('change does not exist: "feature"; run `cabaret create` first');
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
  expect(() => currentBase(change, [])).toThrow('change does not exist: "feature"; run `cabaret create` first');
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
  expect(() => currentOwner(change, [])).toThrow('change does not exist: "feature"; run `cabaret create` first');
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

test("landedMerge finds the land entry, and assertNotLanded rejects it", () => {
  const entry = (timestamp: number, action: LogAction): LogEntry => ({
    timestamp: timestampMs(timestamp),
    user: userName("alice@example.com"),
    action,
  });
  const change = parseRefName("feature");
  const unlanded = [entry(5, { kind: "set-parent", parent: parseRefName("main") })];
  expect(landedMerge(unlanded)).toBeUndefined();
  expect(() => assertNotLanded(change, unlanded)).not.toThrow();
  const landed = [...unlanded, entry(9, { kind: "land", merge: parseCommitHash(SHA1) })];
  expect(landedMerge(landed)).toBe(SHA1);
  expect(() => assertNotLanded(change, landed)).toThrow(`change has landed: "feature" (merge ${SHA1})`);
});

/** The fake commit `digit.repeat(40)`, hex digits only. */
function fake(digit: string): CommitHash {
  return parseCommitHash(digit.repeat(40));
}

/**
 * A backend whose first-parent chain is the fake commits of `digits` (oldest
 * first) and whose land merges are `merges`. Only the members
 * `reviewSegments` touches exist; ancestry is chain order, and anything off
 * the chain is nobody's relative.
 */
function chainBackend(digits: string, merges: readonly LandMerge[]): Backend {
  const chain = [...digits].map(fake);
  const at = (hash: CommitHash) => chain.indexOf(hash);
  const stub: Pick<Backend, "landMerges" | "isAncestor"> = {
    async landMerges(base, tip) {
      return merges.filter(({ commit }) => at(commit) > at(base) && at(commit) <= at(tip));
    },
    async isAncestor(ancestor, descendant) {
      return ancestor === descendant || (at(ancestor) !== -1 && at(descendant) !== -1 && at(ancestor) < at(descendant));
    },
  };
  return stub as Backend;
}

test("reviewSegments splits at land merges and resumes from the reviewed tip", async () => {
  // Lands at 2 (onto 1) and 5 (onto 4); 3-4 and 6-7 are ordinary commits.
  const backend = chainBackend("01234567", [
    { commit: fake("2"), onto: fake("1") },
    { commit: fake("5"), onto: fake("4") },
  ]);
  const segment = (start: string, end: string) => ({ start: fake(start), end: fake(end) });
  expect(await reviewSegments(backend, fake("0"), fake("7"))).toEqual([
    segment("0", "1"),
    segment("2", "4"),
    segment("5", "7"),
  ]);
  // A land right at the base or the tip leaves no span on that side.
  expect(await reviewSegments(backend, fake("1"), fake("5"))).toEqual([segment("2", "4")]);
  // Reviewing up to a land's onto covers everything the land then jumps over.
  expect(await reviewSegments(backend, fake("0"), fake("7"), fake("1"))).toEqual([
    segment("2", "4"),
    segment("5", "7"),
  ]);
  // A reviewed tip inside a span resumes that span from it.
  expect(await reviewSegments(backend, fake("0"), fake("7"), fake("3"))).toEqual([
    segment("3", "4"),
    segment("5", "7"),
  ]);
  expect(await reviewSegments(backend, fake("0"), fake("7"), fake("7"))).toEqual([]);
  // A reviewed tip from outside the chain trims nothing.
  expect(await reviewSegments(backend, fake("0"), fake("7"), fake("f"))).toEqual([
    segment("0", "1"),
    segment("2", "4"),
    segment("5", "7"),
  ]);
});

test("reviewSegments drops the span between back-to-back lands", async () => {
  const backend = chainBackend("0123", [
    { commit: fake("2"), onto: fake("1") },
    { commit: fake("3"), onto: fake("2") },
  ]);
  expect(await reviewSegments(backend, fake("0"), fake("3"))).toEqual([{ start: fake("0"), end: fake("1") }]);
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
  const forges = fc.string({ minLength: 1, unit: "grapheme" }).map(parseForgeLocator);
  const sources = fc.record(
    {
      forge: forges,
      id: fc.string({ minLength: 1 }),
      edits: fc.string({ unit: fc.constantFrom(..."0123456789abcdef"), minLength: 64, maxLength: 64 }),
    },
    { requiredKeys: ["forge", "id"] },
  );
  return fc.oneof(
    fc.record({ kind: fc.constant("set-parent" as const), parent: refNames() }),
    fc.record({ kind: fc.constant("set-base" as const), base: commitHashes() }),
    fc.record({ kind: fc.constant("set-owner" as const), owner: users }),
    fc.record({
      kind: fc.constant("set-forge" as const),
      forge: forges,
      request: fc.integer({ min: 1 }).map(forgeRequestId),
    }),
    fc.record({ kind: fc.constant("review" as const), file: filePaths(), base: commitHashes(), tip: commitHashes() }),
    fc.record({ kind: fc.constant("forget" as const), file: filePaths() }),
    fc.record({ kind: fc.constant("land" as const), merge: commitHashes() }),
    fc.record(
      { kind: fc.constant("comment" as const), text: fc.string({ minLength: 1, unit: "grapheme" }), source: sources },
      { requiredKeys: ["kind", "text"] },
    ),
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

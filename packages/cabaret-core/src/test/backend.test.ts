import fc from "fast-check";
import { expect, test } from "vitest";
import { ZodError } from "zod";
import {
  assertNotArchived,
  brain,
  type ChangeName,
  currentArchived,
  currentBase,
  currentName,
  currentOwner,
  currentParentRef,
  currentReviewers,
  type FilePath,
  finished,
  forgeChangeId,
  forgeChangeUrl,
  formatLogEntry,
  type LogAction,
  type LogEntry,
  landedMerge,
  mergeLogs,
  observedForgeArchived,
  observedForgeReviewers,
  type ParentRef,
  parseBranchName,
  parseChangeId,
  parseCommitHash,
  parseFilePath,
  parseForgeLocator,
  parseLog,
  REVIEWING,
  type Revision,
  type TimestampMs,
  timestampMs,
  type UserName,
  userName,
} from "../index.js";

const SHA1 = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA1 = "fedcba9876543210fedcba9876543210fedcba98";
const SHA256 = SHA1 + SHA1.slice(0, 24);

const branchParent = (name: string): ParentRef => ({ kind: "branch", name: parseBranchName(name) });
const changeParent = (id: string): ParentRef => ({ kind: "change", id: parseChangeId(id) });

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
  for (const ok of ["main", "feature/foo", "release-1.2", "refs/heads/main", "tip", "null", "123", "0x1f"]) {
    expect(parseBranchName(ok)).toBe(ok);
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
    "trailing/",
    "feature/trailing/",
    ".leading-dot",
    "feature/.hidden",
    "feature.lock/child",
  ]) {
    expect(() => parseBranchName(bad)).toThrow("not a valid branch name");
  }
});

test("forgeChangeUrl routes each supported forge, and no other host", () => {
  expect(forgeChangeUrl(parseForgeLocator("github.com/test-org/widgets"), forgeChangeId(7))).toBe(
    "https://github.com/test-org/widgets/pull/7",
  );
  expect(forgeChangeUrl(parseForgeLocator("gitlab.com/test-group/nested/widgets"), forgeChangeId(31))).toBe(
    "https://gitlab.com/test-group/nested/widgets/-/merge_requests/31",
  );
  expect(forgeChangeUrl(parseForgeLocator("codeberg.org/test-org/widgets"), forgeChangeId(2))).toBe(
    "https://codeberg.org/test-org/widgets/pulls/2",
  );
  expect(forgeChangeUrl(parseForgeLocator("forge.example.com/test-org/widgets"), forgeChangeId(7))).toBeUndefined();
});

test("formatLogEntry renders one JSON object per line, keys in schema order", () => {
  expect(
    formatLogEntry({
      // Key order here deliberately differs from the schema's.
      action: { parent: branchParent("main"), kind: "set-parent" },
      user: userName("alice@example.com"),
      timestamp: timestampMs(1748000000000),
    }),
  ).toBe('{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n');
});

test("a change parent serializes as its id object, a branch parent as its plain name", () => {
  const id = "c0de".repeat(8);
  expect(
    formatLogEntry({
      timestamp: timestampMs(1748000000000),
      user: userName("alice@example.com"),
      action: { kind: "set-parent", parent: changeParent(id) },
    }),
  ).toBe(
    `{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":{"id":"${id}"}}}\n`,
  );
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

test("formatLogEntry renders reviewer actions, and a forge-sourced entry keys its source before the action", () => {
  expect(
    formatLogEntry({
      timestamp: timestampMs(1748000000007),
      user: userName("erin@example.com"),
      action: { kind: "add-reviewer", reviewer: userName("frank@example.com") },
    }),
  ).toBe(
    '{"timestamp":1748000000007,"user":"erin@example.com","action":{"kind":"add-reviewer","reviewer":"frank@example.com"}}\n',
  );
  expect(
    formatLogEntry({
      timestamp: timestampMs(1748000000008),
      user: userName("erin@example.com"),
      source: { forge: parseForgeLocator("github.com/test-org/widgets") },
      action: { kind: "remove-reviewer", reviewer: userName("frank@example.com") },
    }),
  ).toBe(
    '{"timestamp":1748000000008,"user":"erin@example.com","source":{"forge":"github.com/test-org/widgets"},"action":{"kind":"remove-reviewer","reviewer":"frank@example.com"}}\n',
  );
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
    action: { kind: "set-parent", parent: branchParent("feature/base") },
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
      action: { kind: "set-parent", parent: branchParent("main") },
    },
    {
      timestamp: timestampMs(1748000060000),
      user: userName('Bob Smith <bob@example.com>\n"tricky"'),
      action: { kind: "set-parent", parent: branchParent("feature/base") },
    },
    {
      timestamp: timestampMs(1748000090000),
      user: userName("alice@example.com"),
      action: { kind: "set-parent", parent: changeParent("f00d".repeat(8)) },
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
        id: forgeChangeId(7),
      },
    },
    {
      timestamp: timestampMs(1748000540000),
      user: userName("github:carol"),
      source: { forge: parseForgeLocator("github.com/test-org/widgets"), id: "3025" },
      action: { kind: "comment", text: "imported" },
    },
    {
      timestamp: timestampMs(1748000600000),
      user: userName("github:carol"),
      source: { forge: parseForgeLocator("github.com/test-org/widgets"), id: "3025" },
      action: { kind: "comment", text: "imported (edited)", edits: "ab".repeat(32) },
    },
  ];
  expect(parseLog(entries.map(formatLogEntry).join(""), parseCommitHash, parseBranchName)).toEqual(entries);
});

test("the empty log parses to no entries", () => {
  expect(parseLog("", parseCommitHash, parseBranchName)).toEqual([]);
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
    [line({ ...entry, action: { kind: "set-parent", parent: { id: "not-hex" } } }), "malformed log line"],
    [line({ ...entry, action: { kind: "set-parent", parent: {} } }), "malformed log line"],
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
    [line({ ...entry, action: { kind: "comment", text: "hi", edits: "" } }), "malformed log line"],
    [line({ ...entry, source: { forge: "", id: "1" } }), "malformed log line"],
    [line({ ...entry, source: { forge: "gh.test/a/b", id: "" } }), "malformed log line"],
    [line({ ...entry, source: {} }), "malformed log line"],
    [line({ ...entry, action: { kind: "set-forge", forge: "gh.test/a/b", id: 0 } }), "malformed log line"],
    [line({ ...entry, action: { kind: "set-forge", forge: "gh.test/a/b", id: 1.5 } }), "malformed log line"],
    [line({ ...entry, action: { kind: "set-forge", id: 1 } }), "malformed log line"],
  ];
  for (const [log, error] of cases) {
    expect(() => parseLog(log, parseCommitHash, parseBranchName)).toThrow(error);
  }
});

test("currentName takes the set-name with the greatest timestamp, and fails without one", () => {
  const entry = (timestamp: number, action: LogAction): LogEntry => ({
    timestamp: timestampMs(timestamp),
    user: userName("alice@example.com"),
    action,
  });
  const id = parseChangeId("0".repeat(32));
  expect(() => currentName(id, [])).toThrow(`log has no name: ${id}`);
  expect(() => currentName(id, [entry(5, { kind: "set-archived", archived: true })])).toThrow(`log has no name: ${id}`);
  expect(
    currentName(id, [
      entry(9, { kind: "set-name", name: parseBranchName("renamed") }),
      entry(3, { kind: "set-name", name: parseBranchName("original") }),
      entry(12, { kind: "set-archived", archived: true }),
    ]),
  ).toBe("renamed");
});

test("currentParentRef takes the set-parent with the greatest timestamp, regardless of order", () => {
  const entry = (timestamp: number, action: LogAction): LogEntry => ({
    timestamp: timestampMs(timestamp),
    user: userName("alice@example.com"),
    action,
  });
  const id = parseChangeId("0".repeat(32));
  expect(() => currentParentRef(id, [])).toThrow(`log has no parent: ${id}`);
  expect(() => currentParentRef(id, [entry(5, { kind: "forget", file: parseFilePath("a.ts") })])).toThrow(
    `log has no parent: ${id}`,
  );
  expect(
    currentParentRef(id, [
      entry(9, { kind: "set-parent", parent: changeParent("c0de".repeat(8)) }),
      entry(3, { kind: "set-parent", parent: branchParent("oldest") }),
      entry(12, {
        kind: "review",
        file: parseFilePath("a.ts"),
        base: parseCommitHash(OTHER_SHA1),
        tip: parseCommitHash(SHA1),
      }),
    ]),
  ).toEqual(changeParent("c0de".repeat(8)));
});

test("currentBase takes the set-base with the greatest timestamp, regardless of order", () => {
  const entry = (timestamp: number, action: LogAction): LogEntry => ({
    timestamp: timestampMs(timestamp),
    user: userName("alice@example.com"),
    action,
  });
  const change = parseBranchName("feature");
  expect(() => currentBase(change, [])).toThrow(
    'change does not exist: "feature"; run `cab create`, or `cab fetch` to import open forge changes',
  );
  expect(() => currentBase(change, [entry(5, { kind: "set-parent", parent: branchParent("main") })])).toThrow(
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
  const change = parseBranchName("feature");
  expect(() => currentOwner(change, [])).toThrow(
    'change does not exist: "feature"; run `cab create`, or `cab fetch` to import open forge changes',
  );
  expect(() => currentOwner(change, [entry(5, { kind: "set-parent", parent: branchParent("main") })])).toThrow(
    'change has no owner: "feature"',
  );
  expect(
    currentOwner(change, [
      entry(9, { kind: "set-owner", owner: userName("carol@example.com") }),
      entry(3, { kind: "set-owner", owner: userName("bob@example.com") }),
      entry(12, { kind: "set-parent", parent: branchParent("main") }),
    ]),
  ).toBe("carol@example.com");
});

test("currentReviewers folds each user's latest add/remove; observedForgeReviewers only source-bearing ones", () => {
  const entry = (timestamp: number, action: LogAction, source?: LogEntry["source"]): LogEntry => ({
    timestamp: timestampMs(timestamp),
    user: userName("alice@example.com"),
    ...(source === undefined ? {} : { source }),
    action,
  });
  const bob = userName("bob@example.com");
  const carol = userName("carol@example.com");
  const forge = parseForgeLocator("github.com/test-org/widgets");
  expect(currentReviewers([])).toEqual([]);
  const entries = [
    // bob: added, removed later — out.
    entry(5, { kind: "add-reviewer", reviewer: bob }),
    entry(9, { kind: "remove-reviewer", reviewer: bob }),
    // carol: removed on the forge, then re-added locally — in, but the
    // forge's last observation stays a removal.
    entry(3, { kind: "add-reviewer", reviewer: carol }, { forge }),
    entry(6, { kind: "remove-reviewer", reviewer: carol }, { forge }),
    entry(8, { kind: "add-reviewer", reviewer: carol }),
  ];
  expect(currentReviewers(entries)).toEqual([carol]);
  expect(observedForgeReviewers(entries, forge)).toEqual(new Set());
  expect(observedForgeReviewers(entries.slice(0, 3), forge)).toEqual(new Set([carol]));
  // Another forge's observations are not this forge's.
  expect(observedForgeReviewers(entries, parseForgeLocator("gitlab.com/test-org/widgets"))).toEqual(new Set());
});

test("landedMerge finds the land entry, and finished asks for archived alongside it", () => {
  const entry = (timestamp: number, action: LogAction): LogEntry => ({
    timestamp: timestampMs(timestamp),
    user: userName("alice@example.com"),
    action,
  });
  const unlanded = [entry(5, { kind: "set-parent", parent: branchParent("main") })];
  expect(landedMerge(unlanded)).toBeUndefined();
  expect(finished(unlanded)).toBe(false);
  const landed = [...unlanded, entry(9, { kind: "land", merge: parseCommitHash(SHA1) })];
  expect(landedMerge(landed)).toBe(SHA1);
  // Landed but live — permanent structure, or reopened — is not finished.
  expect(finished(landed)).toBe(false);
  expect(finished([...landed, entry(10, { kind: "set-archived", archived: true })])).toBe(true);
  expect(
    finished([
      ...landed,
      entry(10, { kind: "set-archived", archived: true }),
      entry(11, { kind: "set-archived", archived: false }),
    ]),
  ).toBe(false);
});

test("currentArchived takes the set-archived with the greatest timestamp, and assertNotArchived rejects it", () => {
  const entry = (timestamp: number, archived: boolean, source?: string): LogEntry => ({
    timestamp: timestampMs(timestamp),
    user: userName("alice@example.com"),
    ...(source === undefined ? {} : { source: { forge: parseForgeLocator(source) } }),
    action: { kind: "set-archived", archived },
  });
  const change = parseBranchName("feature");
  expect(currentArchived([])).toBe(false);
  expect(() => assertNotArchived(change, [])).not.toThrow();
  // Order in the log does not matter, only timestamps.
  const revived = [entry(9, false), entry(5, true)];
  expect(currentArchived(revived)).toBe(false);
  const archived = [entry(5, false), entry(9, true)];
  expect(currentArchived(archived)).toBe(true);
  expect(() => assertNotArchived(change, archived)).toThrow('change is archived: "feature"; run `cab archive --undo`');
});

test("observedForgeArchived reads only entries sourced from the forge", () => {
  const entry = (timestamp: number, archived: boolean, source?: string): LogEntry => ({
    timestamp: timestampMs(timestamp),
    user: userName("alice@example.com"),
    ...(source === undefined ? {} : { source: { forge: parseForgeLocator(source) } }),
    action: { kind: "set-archived", archived },
  });
  const forge = parseForgeLocator("github.com/test-org/widgets");
  expect(observedForgeArchived([], forge)).toBeUndefined();
  // A local unarchive does not count as an observation, however recent.
  const entries = [entry(5, true, "github.com/test-org/widgets"), entry(9, false)];
  expect(observedForgeArchived(entries, forge)).toBe(true);
  expect(observedForgeArchived(entries, parseForgeLocator("gitlab.com/test-org/widgets"))).toBeUndefined();
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
    at(5, alice, { kind: "set-parent", parent: branchParent("main") }),
    at(10, alice, { kind: "set-base", base: parseCommitHash(SHA256) }),
    // Equal timestamps: the serialized entry, not log position, breaks the
    // tie, and `"kind":"review"` sorts after `"kind":"forget"`.
    at(6, alice, review("d.ts", SHA1, OTHER_SHA1)),
    at(6, alice, { kind: "forget", file: parseFilePath("d.ts") }),
    at(7, alice, { kind: "forget", file: parseFilePath("e.ts") }),
    at(7, alice, review("e.ts", OTHER_SHA1, SHA256)),
  ];
  expect(brain(entries, alice)).toEqual(
    new Map([
      [parseFilePath("a.ts"), { base: SHA1, tip: SHA256 }],
      [parseFilePath("c.ts"), { base: SHA1, tip: SHA1 }],
      [parseFilePath("d.ts"), { base: SHA1, tip: OTHER_SHA1 }],
      [parseFilePath("e.ts"), { base: OTHER_SHA1, tip: SHA256 }],
    ]),
  );
  expect(brain(entries, bob)).toEqual(new Map());
  expect(brain([], alice)).toEqual(new Map());
});

function refNames(): fc.Arbitrary<ChangeName> {
  const valid = (raw: string): boolean => {
    try {
      parseBranchName(raw);
      return true;
    } catch {
      return false;
    }
  };
  return fc.string({ minLength: 1, maxLength: 30 }).filter(valid).map(parseBranchName);
}

function parentRefs(): fc.Arbitrary<ParentRef> {
  const ids = fc
    .string({ unit: fc.constantFrom(..."0123456789abcdef"), minLength: 32, maxLength: 32 })
    .map(parseChangeId);
  return fc.oneof(
    refNames().map((name): ParentRef => ({ kind: "branch", name })),
    ids.map((id): ParentRef => ({ kind: "change", id })),
  );
}

function filePaths(): fc.Arbitrary<FilePath> {
  return fc
    .string({ minLength: 1, unit: "grapheme" })
    .filter((raw) => !raw.includes("\0"))
    .map(parseFilePath);
}

function commitHashes(): fc.Arbitrary<Revision> {
  return fc.string({ unit: fc.constantFrom(..."0123456789abcdef"), minLength: 40, maxLength: 40 }).map(parseCommitHash);
}

function logActions(): fc.Arbitrary<LogAction> {
  const users = fc.string({ minLength: 1, unit: "grapheme" }).map(userName);
  const forges = fc.string({ minLength: 1, unit: "grapheme" }).map(parseForgeLocator);
  return fc.oneof(
    fc.record({ kind: fc.constant("set-name" as const), name: refNames() }),
    fc.record({ kind: fc.constant("set-parent" as const), parent: parentRefs() }),
    fc.record({ kind: fc.constant("set-base" as const), base: commitHashes() }),
    fc.record({ kind: fc.constant("set-owner" as const), owner: users }),
    fc.record({
      kind: fc.constant("set-forge" as const),
      forge: forges,
      id: fc.integer({ min: 1 }).map(forgeChangeId),
    }),
    fc.record({ kind: fc.constant("set-reviewing" as const), reviewing: fc.constantFrom(...REVIEWING) }),
    fc.record({ kind: fc.constant("set-archived" as const), archived: fc.boolean() }),
    fc.record({ kind: fc.constant("set-permanent" as const), permanent: fc.boolean() }),
    fc.record({ kind: fc.constant("add-reviewer" as const), reviewer: users }),
    fc.record({ kind: fc.constant("remove-reviewer" as const), reviewer: users }),
    fc.record({ kind: fc.constant("review" as const), file: filePaths(), base: commitHashes(), tip: commitHashes() }),
    fc.record({ kind: fc.constant("forget" as const), file: filePaths() }),
    fc.record({ kind: fc.constant("land" as const), merge: commitHashes() }),
    fc.record(
      {
        kind: fc.constant("comment" as const),
        text: fc.string({ minLength: 1, unit: "grapheme" }),
        edits: fc.string({ unit: fc.constantFrom(..."0123456789abcdef"), minLength: 64, maxLength: 64 }),
      },
      { requiredKeys: ["kind", "text"] },
    ),
  );
}

function logEntries(): fc.Arbitrary<LogEntry> {
  const forges = fc.string({ minLength: 1, unit: "grapheme" }).map(parseForgeLocator);
  return fc.record(
    {
      timestamp: fc.maxSafeNat().map(timestampMs),
      user: fc.string({ minLength: 1, unit: "grapheme" }).map(userName),
      source: fc.record({ forge: forges, id: fc.string({ minLength: 1 }) }, { requiredKeys: ["forge"] }),
      action: logActions(),
    },
    { requiredKeys: ["timestamp", "user", "action"] },
  );
}

test("format/parse round-trips arbitrary logs", () => {
  fc.assert(
    fc.property(fc.array(logEntries()), (entries) => {
      expect(parseLog(entries.map(formatLogEntry).join(""), parseCommitHash, parseBranchName)).toEqual(entries);
    }),
  );
});

/** Entries with clustered timestamps and a small identity pool, so ties are common. */
function tiedEntries(): fc.Arbitrary<LogEntry> {
  return fc.record({
    timestamp: fc.integer({ min: 0, max: 3 }).map(timestampMs),
    user: fc.constantFrom("alice@example.com", "bob@example.com").map(userName),
    action: logActions(),
  });
}

test("mergeLogs unions, dedupes, and orders by timestamp then serialized line", () => {
  const alice = userName("alice@example.com");
  const bob = userName("bob@example.com");
  const parent = (timestamp: number, user: UserName, name: string): LogEntry => ({
    timestamp: timestampMs(timestamp),
    user,
    action: { kind: "set-parent", parent: branchParent(name) },
  });
  const shared = parent(1, alice, "main");
  expect(
    mergeLogs([shared, parent(3, alice, "trunk-a")], [parent(3, bob, "trunk-b"), shared, parent(2, bob, "dev")]),
  ).toEqual([shared, parent(2, bob, "dev"), parent(3, alice, "trunk-a"), parent(3, bob, "trunk-b")]);
});

test("mergeLogs is commutative, associative, and idempotent", () => {
  const logs = fc.array(tiedEntries());
  fc.assert(
    fc.property(logs, logs, logs, (a, b, c) => {
      const ab = mergeLogs(a, b);
      expect(mergeLogs(b, a)).toEqual(ab);
      expect(mergeLogs(ab, c)).toEqual(mergeLogs(a, mergeLogs(b, c)));
      expect(mergeLogs(ab, ab)).toEqual(ab);
      expect(mergeLogs(ab, b)).toEqual(ab);
    }),
  );
});

// The convergence guarantee: two machines whose logs hold the same entries
// read the same state, no matter how merging interleaved them.
test("log reads agree on any interleaving of the same entries", () => {
  const alice = userName("alice@example.com");
  const bob = userName("bob@example.com");
  const seeded = fc
    .array(tiedEntries())
    .map((entries): readonly LogEntry[] => [
      { timestamp: timestampMs(0), user: alice, action: { kind: "set-parent", parent: branchParent("main") } },
      { timestamp: timestampMs(0), user: alice, action: { kind: "set-base", base: parseCommitHash(SHA1) } },
      { timestamp: timestampMs(0), user: alice, action: { kind: "set-owner", owner: alice } },
      ...entries,
    ]);
  const withShuffle = seeded.chain((log) =>
    fc.tuple(fc.constant(log), fc.shuffledSubarray([...log], { minLength: log.length })),
  );
  fc.assert(
    fc.property(withShuffle, ([log, shuffled]) => {
      const change = parseBranchName("widgets");
      const id = parseChangeId("0".repeat(32));
      expect(currentParentRef(id, shuffled)).toEqual(currentParentRef(id, log));
      expect(currentBase(change, shuffled)).toBe(currentBase(change, log));
      expect(currentOwner(change, shuffled)).toBe(currentOwner(change, log));
      expect(landedMerge(shuffled)).toBe(landedMerge(log));
      expect(brain(shuffled, alice)).toEqual(brain(log, alice));
      expect(brain(shuffled, bob)).toEqual(brain(log, bob));
    }),
  );
});

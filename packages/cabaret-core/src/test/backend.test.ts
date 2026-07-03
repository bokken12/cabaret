import fc from "fast-check";
import { expect, test } from "vitest";
import {
  formatLogEntry,
  type LogEntry,
  parseCommitHash,
  parseLog,
  parseRefName,
  type RefName,
  userName,
} from "../index.js";

const SHA1 = "0123456789abcdef0123456789abcdef01234567";
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

test("formatLogEntry renders one space-separated line", () => {
  expect(
    formatLogEntry({
      timestamp: 1748000000000,
      user: userName("alice@example.com"),
      action: { kind: "set-parent", parent: parseRefName("main") },
    }),
  ).toBe("1748000000000 alice@example.com set-parent main\n");
});

test("formatLogEntry rejects entries that would corrupt the line format", () => {
  const entry = {
    timestamp: 1748000060000,
    user: userName("bob@example.com"),
    action: { kind: "set-parent", parent: parseRefName("feature/base") },
  } as const;
  for (const bad of [
    { ...entry, timestamp: 0.5 },
    { ...entry, timestamp: -1 },
    { ...entry, timestamp: 2 ** 53 },
    { ...entry, user: userName("") },
    { ...entry, user: userName("bob smith") },
  ]) {
    expect(() => formatLogEntry(bad)).toThrow("malformed log entry");
  }
});

test("a formatted log parses back to the original entries", () => {
  const entries: LogEntry[] = [
    {
      timestamp: 1748000000000,
      user: userName("alice@example.com"),
      action: { kind: "set-parent", parent: parseRefName("main") },
    },
    {
      timestamp: 1748000060000,
      user: userName("bob@example.com"),
      action: { kind: "set-parent", parent: parseRefName("feature/base") },
    },
  ];
  expect(parseLog(entries.map(formatLogEntry).join(""))).toEqual(entries);
});

test("the empty log parses to no entries", () => {
  expect(parseLog("")).toEqual([]);
});

test("parseLog rejects malformed logs", () => {
  const cases: [string, string][] = [
    ["1748000000000 alice@example.com set-parent main", "missing trailing newline"],
    ["not a log line\n", "malformed log line"],
    ["1748000000000 alice@example.com\n", "malformed log line"],
    ["99999999999999999999 alice@example.com set-parent main\n", "malformed log line"],
    ["1748000000000 alice@example.com merge main\n", "unknown log action"],
    ["1748000000000 alice@example.com set-parent bad..ref\n", "not a valid ref name"],
  ];
  for (const [log, error] of cases) {
    expect(() => parseLog(log)).toThrow(error);
  }
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

function logEntries(): fc.Arbitrary<LogEntry> {
  return fc.record({
    timestamp: fc.maxSafeNat(),
    user: fc
      .string({ minLength: 1 })
      .filter((raw) => !/\s/.test(raw))
      .map(userName),
    action: fc.record({ kind: fc.constant("set-parent" as const), parent: refNames() }),
  });
}

test("format/parse round-trips arbitrary logs", () => {
  fc.assert(
    fc.property(fc.array(logEntries()), (entries) => {
      expect(parseLog(entries.map(formatLogEntry).join(""))).toEqual(entries);
    }),
  );
});

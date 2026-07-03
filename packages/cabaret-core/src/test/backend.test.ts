import fc from "fast-check";
import { expect, test } from "vitest";
import { ZodError } from "zod";
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

test("formatLogEntry renders one JSON object per line, keys in schema order", () => {
  expect(
    formatLogEntry({
      // Key order here deliberately differs from the schema's.
      action: { parent: parseRefName("main"), kind: "set-parent" },
      user: userName("alice@example.com"),
      timestamp: 1748000000000,
    }),
  ).toBe('{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n');
});

test("formatLogEntry rejects invalid timestamps and users", () => {
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
  ]) {
    expect(() => formatLogEntry(bad)).toThrow(ZodError);
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
      user: userName('Bob Smith <bob@example.com>\n"tricky"'),
      action: { kind: "set-parent", parent: parseRefName("feature/base") },
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
    user: fc.string({ minLength: 1, unit: "grapheme" }).map(userName),
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

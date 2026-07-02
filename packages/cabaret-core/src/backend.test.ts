import { expect, test } from "vitest";
import { formatLogEntry, parseCommitHash, parseRefName } from "./index.js";

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
  expect(formatLogEntry({ timestamp: 1748000000, user: "alice@example.com", action: "set-parent main" })).toBe(
    "1748000000 alice@example.com set-parent main\n",
  );
});

test("formatLogEntry rejects entries that would corrupt the line format", () => {
  const entry = { timestamp: 1748000060, user: "bob@example.com", action: 'comment "fine"' };
  for (const bad of [
    { ...entry, timestamp: 0.5 },
    { ...entry, user: "" },
    { ...entry, user: "bob smith" },
    { ...entry, action: "" },
    { ...entry, action: "line\nbreak" },
  ]) {
    expect(() => formatLogEntry(bad)).toThrow("malformed log entry");
  }
});

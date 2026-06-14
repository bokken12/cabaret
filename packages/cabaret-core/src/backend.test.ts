import { expect, test } from "vitest";
import { parseCommitHash } from "./index.js";

const SHA1 = "0123456789abcdef0123456789abcdef01234567";
const SHA256 = SHA1 + SHA1.slice(0, 24);

test("parses full sha1 and sha256 hashes", () => {
  expect(parseCommitHash(SHA1)).toBe(SHA1);
  expect(parseCommitHash(SHA256)).toBe(SHA256);
});

test("rejects anything else", () => {
  for (const bad of [
    "",
    "HEAD",
    SHA1.slice(0, 7),
    SHA1.toUpperCase(),
    `${SHA1}\n`,
  ]) {
    expect(() => parseCommitHash(bad)).toThrow("not a commit hash");
  }
});

import { type FilePath, parseFilePath, parseRefName, type RefName } from "cabaret-core";
import fc from "fast-check";
import { expect, test } from "vitest";
import { parseRevPath, type Rev, revPath } from "../revs.js";

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
    .string({ minLength: 1, maxLength: 30 })
    .filter((raw) => !raw.includes("\0"))
    .map(parseFilePath);
}

function revs(): fc.Arbitrary<Rev> {
  return fc.record({
    side: fc.constantFrom<Rev["side"]>("prev", "next"),
    change: refNames(),
    file: filePaths(),
  });
}

test("rev paths round-trip", () => {
  fc.assert(
    fc.property(revs(), (rev) => {
      expect(parseRevPath(revPath(rev))).toEqual(rev);
    }),
  );
});

test("rev paths round-trip for files with colons and slashes", () => {
  // The first `:` ends the change (no ref name contains one); the file keeps
  // the rest, colons and all.
  for (const raw of ["a:b", "src/a.ts", "src/with:colon.ts", "a b.txt"]) {
    const rev: Rev = { side: "next", change: parseRefName("feature/x"), file: parseFilePath(raw) };
    expect(parseRevPath(revPath(rev))).toEqual(rev);
  }
});

test("paths that name no rev are refused", () => {
  for (const path of ["", "/", "/prev", "/prev/x", "/prev/x:", "/prev/:y", "/left/x:y", "/diff/x:y"]) {
    expect(() => parseRevPath(path)).toThrowError(/not a cabaret rev/);
  }
});

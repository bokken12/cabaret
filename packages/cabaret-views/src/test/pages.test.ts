import { type ChangeName, type FilePath, parseBranchName, parseFilePath } from "cabaret-core";
import fc from "fast-check";
import { expect, test } from "vitest";
import { type Page, pagePath, parsePagePath } from "../pages.js";

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

function filePaths(): fc.Arbitrary<FilePath> {
  return fc
    .string({ minLength: 1, maxLength: 30 })
    .filter((raw) => !raw.includes("\0"))
    .map(parseFilePath);
}

function pages(): fc.Arbitrary<Page> {
  return fc.oneof(
    fc.constant<Page>({ kind: "todo" }),
    refNames().map((change): Page => ({ kind: "show", change })),
    refNames().map((change): Page => ({ kind: "review", change })),
    fc
      .record({ change: refNames(), file: filePaths() })
      .map(({ change, file }): Page => ({ kind: "diff", change, file })),
  );
}

test("page paths round-trip", () => {
  fc.assert(
    fc.property(pages(), (page) => {
      expect(parsePagePath(pagePath(page))).toEqual(page);
    }),
  );
});

test("page paths round-trip for ref names with path and encoding characters", () => {
  for (const raw of ["a/b", "a#b", "a%23b", "feature/x.y"]) {
    const page: Page = { kind: "show", change: parseBranchName(raw) };
    expect(parsePagePath(pagePath(page))).toEqual(page);
  }
});

test("diff page paths round-trip for files with colons and slashes", () => {
  // The first `:` ends the change (no ref name contains one); the file keeps
  // the rest, colons and all.
  for (const raw of ["a:b", "src/a.ts", "src/with:colon.ts", "a b.txt"]) {
    const page: Page = { kind: "diff", change: parseBranchName("feature/x"), file: parseFilePath(raw) };
    expect(parsePagePath(pagePath(page))).toEqual(page);
  }
});

test("paths that name no page are refused", () => {
  for (const path of ["", "/", "todo", "/todos", "/show", "/show/", "/review/", "/diff/x", "/diff/x:", "/diff/:y"]) {
    expect(() => parsePagePath(path)).toThrowError(/not a cabaret page/);
  }
});

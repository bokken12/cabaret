import { type ChangeName, type FilePath, parseBranchName, parseFilePath, type UserName, userName } from "cabaret-core";
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

function userNames(): fc.Arbitrary<UserName> {
  return fc.string({ minLength: 1, maxLength: 30 }).map(userName);
}

function pages(): fc.Arbitrary<Page> {
  return fc.oneof(
    fc.constant<Page>({ kind: "todo" }),
    refNames().map((change): Page => ({ kind: "show", change })),
    refNames().map((change): Page => ({ kind: "review", change })),
    fc.record({ change: refNames(), as: userNames() }).map(({ change, as }): Page => ({ kind: "review", change, as })),
    refNames().map((change): Page => ({ kind: "diffs", change })),
    fc.record({ change: refNames(), as: userNames() }).map(({ change, as }): Page => ({ kind: "diffs", change, as })),
    fc
      .record({ change: refNames(), file: filePaths() })
      .map(({ change, file }): Page => ({ kind: "diff", change, file })),
    fc
      .record({ change: refNames(), file: filePaths(), as: userNames() })
      .map(({ change, file, as }): Page => ({ kind: "diff", change, file, as })),
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

test("as-page paths round-trip for user names full of path and encoding characters", () => {
  // The user's own segment is percent-encoded, so its slashes and colons
  // cannot bleed into the change or file.
  for (const raw of ["github:alice", "a/b@example.com", "100%", "café@example.com"]) {
    const change = parseBranchName("feature/x");
    const as = userName(raw);
    const review: Page = { kind: "review", change, as };
    expect(parsePagePath(pagePath(review))).toEqual(review);
    const diff: Page = { kind: "diff", change, file: parseFilePath("src/with:colon.ts"), as };
    expect(parsePagePath(pagePath(diff))).toEqual(diff);
  }
});

test("paths that name no page are refused", () => {
  for (const path of [
    "",
    "/",
    "todo",
    "/todos",
    "/show",
    "/show/",
    "/review/",
    "/diff/x",
    "/diff/x:",
    "/diff/:y",
    "/review-as/",
    "/review-as/u",
    "/review-as//x",
    "/diff-as/u/x",
    "/diff-as/u/x:",
  ]) {
    expect(() => parsePagePath(path)).toThrowError(/not a cabaret page/);
  }
});

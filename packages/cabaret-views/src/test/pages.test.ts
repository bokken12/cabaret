import { type ChangeName, type FilePath, parseBranchName, parseFilePath, type UserName, userName } from "cabaret-core";
import fc from "fast-check";
import { expect, test } from "vitest";
import { enclosingPage, type Page, pagePath, parsePagePath } from "../pages.js";

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

/** Every page shape, with and without a borrowed identity. */
function pages(): fc.Arbitrary<Page> {
  const bare = fc.oneof(
    fc.constant<Page>({ kind: "home" }),
    refNames().map((change): Page => ({ kind: "show", change })),
    refNames().map((change): Page => ({ kind: "review", change })),
    refNames().map((change): Page => ({ kind: "diffs", change })),
    fc
      .record({ change: refNames(), file: filePaths() })
      .map(({ change, file }): Page => ({ kind: "diff", change, file })),
  );
  return fc.oneof(
    bare,
    fc.record({ page: bare, as: userNames() }).map(({ page, as }): Page => ({ ...page, as })),
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
  // cannot bleed into the page kind, change, or file.
  for (const raw of ["github:alice", "a/b@example.com", "100%", "café@example.com", "home"]) {
    const change = parseBranchName("feature/x");
    const as = userName(raw);
    const home: Page = { kind: "home", as };
    expect(parsePagePath(pagePath(home))).toEqual(home);
    const review: Page = { kind: "review", change, as };
    expect(parsePagePath(pagePath(review))).toEqual(review);
    const diff: Page = { kind: "diff", change, file: parseFilePath("src/with:colon.ts"), as };
    expect(parsePagePath(pagePath(diff))).toEqual(diff);
  }
});

test("stepping outside walks diff pages to review to show to home, keeping the identity", () => {
  const change = parseBranchName("feature/x");
  const as = userName("alice@example.com");
  expect(enclosingPage({ kind: "diff", change, file: parseFilePath("src/a.ts"), as })).toEqual({
    kind: "review",
    change,
    as,
  });
  expect(enclosingPage({ kind: "diffs", change })).toEqual({ kind: "review", change, as: undefined });
  expect(enclosingPage({ kind: "review", change, as })).toEqual({ kind: "show", change, as });
  expect(enclosingPage({ kind: "show", change })).toEqual({ kind: "home", as: undefined });
  expect(enclosingPage({ kind: "home", as })).toBeUndefined();
});

test("every page reaches home in a few steps outside", () => {
  fc.assert(
    fc.property(pages(), (page) => {
      let current: Page | undefined = page;
      let steps = 0;
      while (current !== undefined && current.kind !== "home") {
        current = enclosingPage(current);
        steps++;
      }
      expect(current).toEqual({ kind: "home", as: page.as });
      expect(steps).toBeLessThanOrEqual(3);
    }),
  );
});

test("paths that name no page are refused", () => {
  for (const path of [
    "",
    "/",
    "home",
    "/homes",
    "/show",
    "/show/",
    "/review/",
    "/diff/x",
    "/diff/x:",
    "/diff/:y",
    "/as/",
    "/as/u",
    "/as/u/",
    "/as//home",
    "/as/u/nope",
    "/as/u/as/v/home",
  ]) {
    expect(() => parsePagePath(path)).toThrowError(/not a cabaret page/);
  }
});

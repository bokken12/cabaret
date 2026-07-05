import { parseRefName, type RefName } from "cabaret-core";
import fc from "fast-check";
import { expect, test } from "vitest";
import { type Page, pagePath, parsePagePath } from "../pages.js";

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

function pages(): fc.Arbitrary<Page> {
  return fc.oneof(
    fc.constant<Page>({ kind: "todo" }),
    refNames().map((change): Page => ({ kind: "show", change })),
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
    const page: Page = { kind: "show", change: parseRefName(raw) };
    expect(parsePagePath(pagePath(page))).toEqual(page);
  }
});

test("paths that name no page are refused", () => {
  for (const path of ["", "/", "todo", "/todos", "/show", "/show/"]) {
    expect(() => parsePagePath(path)).toThrowError(/not a cabaret page/);
  }
});

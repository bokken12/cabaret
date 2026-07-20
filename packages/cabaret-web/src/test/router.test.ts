import { parseBranchName, parseFilePath, userName } from "cabaret-core";
import type { Page } from "cabaret-views";
import { expect, test } from "vitest";
import { currentHash, pageFromHash, pageHash } from "../router.js";

test("an empty hash is home", () => {
  expect(pageFromHash("")).toEqual({ kind: "home" });
  expect(pageFromHash("#")).toEqual({ kind: "home" });
  expect(pageFromHash("#/")).toEqual({ kind: "home" });
});

test("hashes round-trip through pageHash and pageFromHash", () => {
  const pages: Page[] = [
    { kind: "home" },
    { kind: "show", change: parseBranchName("widgets") },
    { kind: "review", change: parseBranchName("feature/gadgets") },
    { kind: "diffs", change: parseBranchName("gizmos") },
    { kind: "diff", change: parseBranchName("widgets"), file: parseFilePath("src/api.ts") },
    { kind: "review", change: parseBranchName("widgets"), as: userName("alice@example.com") },
    // Characters the URL would claim survive the hash percent-encoded.
    { kind: "diff", change: parseBranchName("widgets"), file: parseFilePath("docs/spec v2 #1?.md") },
    { kind: "diff", change: parseBranchName("odd%name"), file: parseFilePath("odd/100%.ts") },
  ];
  for (const page of pages) {
    expect(pageFromHash(pageHash(page))).toEqual(page);
  }
});

test("a hash that names no page throws", () => {
  expect(() => pageFromHash("#/cabaret/nonsense")).toThrowError(/not a cabaret page/);
});

test("currentHash reads the fragment off the href, empty when absent", () => {
  expect(currentHash("http://localhost:8484/#/cabaret/diff/w:100%25.ts")).toBe("#/cabaret/diff/w:100%25.ts");
  expect(currentHash("http://localhost:8484/")).toBe("");
});

import { parseBranchName, parseFilePath, userName } from "cabaret-core";
import { expect, test } from "vitest";
import { followTarget } from "../follow.js";

const widgets = parseBranchName("widgets");
const gadgets = parseBranchName("gadgets");
const alice = userName("alice@example.com");

test("change and review targets open their pages, keeping a borrowed identity", () => {
  expect(followTarget({ kind: "change", change: widgets })).toEqual({
    kind: "page",
    page: { kind: "show", change: widgets, as: undefined },
  });
  expect(followTarget({ kind: "review", change: gadgets, as: alice })).toEqual({
    kind: "page",
    page: { kind: "review", change: gadgets, as: alice },
  });
});

test("a file target opens its diff page", () => {
  const file = parseFilePath("src/api.ts");
  expect(followTarget({ kind: "file", change: widgets, file })).toEqual({
    kind: "page",
    page: { kind: "diff", change: widgets, file, as: undefined },
  });
});

test("a url target opens externally, but only for web URLs", () => {
  expect(followTarget({ kind: "url", url: "https://example.com/test-org/widgets" })).toEqual({
    kind: "external",
    url: "https://example.com/test-org/widgets",
  });
  expect(followTarget({ kind: "url", url: "javascript:alert(1)" })).toEqual({
    kind: "note",
    text: "not a web URL: javascript:alert(1)",
  });
});

test("targets needing a working tree report where to go instead", () => {
  expect(followTarget({ kind: "location", change: widgets, file: parseFilePath("src/api.ts"), line: 12 })).toEqual({
    kind: "note",
    text: "src/api.ts:12 opens from a host with a checkout",
  });
  expect(followTarget({ kind: "workspace", path: "/work/widgets" })).toEqual({
    kind: "note",
    text: "workspace at /work/widgets",
  });
  expect(followTarget({ kind: "action", change: gadgets, action: "land" })).toEqual({
    kind: "note",
    text: "land runs from a host with a checkout",
  });
});

import {
  type ChangeSummary,
  type CommitHash,
  forgeRequestId,
  parseCommitHash,
  parseFilePath,
  parseForgeLocator,
  parseRefName,
  userName,
} from "cabaret-core";
import { expect, test } from "vitest";
import { docText, showDoc, targetAt, todoDoc } from "../index.js";

function fake(digit: string): CommitHash {
  return parseCommitHash(digit.repeat(40));
}

const alice = userName("alice@example.com");

function summary(change: string, opts: Partial<ChangeSummary>): ChangeSummary {
  return {
    change: parseRefName(change),
    parent: parseRefName("main"),
    owner: alice,
    forgeRequest: undefined,
    landed: undefined,
    base: fake("1"),
    tip: fake("2"),
    reviewLeft: [],
    nextStep: "review",
    ...opts,
  };
}

const files = (...names: string[]) => names.map(parseFilePath);

test("todoDoc lays out the review table and the owned tree", () => {
  const gadget = summary("gadget", { landed: fake("5"), nextStep: "landed", tip: fake("3") });
  const gizmo = summary("gizmo", {
    parent: parseRefName("gadget"),
    reviewLeft: files("gizmo.ts", "shared.ts"),
    base: fake("3"),
    tip: fake("4"),
  });
  const widgets = summary("widgets", { reviewLeft: [], nextStep: "land" });
  const doc = todoDoc({
    review: [gizmo],
    owned: [
      { summary: gadget, children: [{ summary: gizmo, children: [] }] },
      { summary: widgets, children: [] },
    ],
  });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "|-----------------|
    | change | review |
    |--------+--------|
    | gizmo  |      2 |
    |-----------------|

    Changes you own:
    |------------------------------|
    | change  | review | next step |
    |---------+--------+-----------|
    | gadget  |        | landed    |
    |   gizmo |      2 | review    |
    | widgets |        | land      |
    |------------------------------|"
  `);
  // Cursor on an indented change name resolves to that change.
  const line = docText(doc)
    .split("\n")
    .findIndex((text) => text.includes("  gizmo"));
  expect(targetAt(doc, { line, column: 4 })).toEqual({ kind: "change", change: "gizmo" });
});

test("todoDoc with nothing to do says so", () => {
  expect(docText(todoDoc({ review: [], owned: [] }))).toMatchInlineSnapshot(`"Nothing to do."`);
});

test("showDoc renders the attribute table and files left", () => {
  const doc = showDoc(
    summary("widgets", {
      forgeRequest: { forge: parseForgeLocator("github.com/test-org/widgets"), request: forgeRequestId(7) },
      reviewLeft: files("api.ts", "ui.ts"),
    }),
  );
  expect(docText(doc)).toMatchInlineSnapshot(`
    "widgets
    =======

    |-----------------------------------------------|
    | attribute     | value                         |
    |---------------+-------------------------------|
    | next step     | review                        |
    | owner         | alice@example.com             |
    | parent        | main                          |
    | forge request | github.com/test-org/widgets#7 |
    | tip           | 222222222222                  |
    | base          | 111111111111                  |
    |-----------------------------------------------|

    Files to review:
      api.ts
      ui.ts"
  `);
  const line = docText(doc)
    .split("\n")
    .findIndex((text) => text.includes("api.ts"));
  expect(targetAt(doc, { line, column: 2 })).toEqual({ kind: "file", change: "widgets", file: "api.ts" });
});

test("showDoc renders a landed change without a files section", () => {
  const doc = showDoc(summary("widgets", { landed: fake("5"), nextStep: "landed" }));
  expect(docText(doc)).toMatchInlineSnapshot(`
    "widgets
    =======

    |-------------------------------|
    | attribute | value             |
    |-----------+-------------------|
    | next step | landed            |
    | owner     | alice@example.com |
    | parent    | main              |
    | landed    | 555555555555      |
    | tip       | 222222222222      |
    | base      | 111111111111      |
    |-------------------------------|"
  `);
});

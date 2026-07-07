import {
  type ChangeSummary,
  type CommitHash,
  type ForgeRequest,
  forgeRequestId,
  parseCommitHash,
  parseFilePath,
  parseForgeLocator,
  parseRefName,
  userName,
} from "cabaret-core";
import { expect, test } from "vitest";
import { docText, showDoc, type TodoItem, targetAt, todoDoc } from "../index.js";

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

test("todoDoc lays out the review table and the owned tree, requests standing in as changes", () => {
  const change = (summary: ChangeSummary): TodoItem => ({ kind: "change", summary });
  const gadget = summary("gadget", { landed: fake("5"), nextStep: "landed", tip: fake("3") });
  const gizmo = summary("gizmo", {
    parent: parseRefName("gadget"),
    reviewLeft: files("gizmo.ts", "shared.ts"),
    base: fake("3"),
    tip: fake("4"),
  });
  const widgets = summary("widgets", { reviewLeft: [], nextStep: "land" });
  const request: ForgeRequest = {
    id: forgeRequestId(7),
    head: parseRefName("their-feature"),
    base: parseRefName("main"),
    title: "Their feature",
    author: alice,
    state: "open",
    changedFiles: 3,
  };
  const doc = todoDoc({
    review: [change(gizmo), { kind: "request", request }],
    owned: [
      { item: change(gadget), children: [{ item: change(gizmo), children: [] }] },
      { item: change(widgets), children: [] },
      { item: { kind: "request", request }, children: [] },
    ],
  });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "╭───────────────┬────────╮
    │ change        │ review │
    ├───────────────┼────────┤
    │ gizmo         │      2 │
    │ their-feature │      3 │
    ╰───────────────┴────────╯

    Changes you own:
    ╭───────────────┬────────┬───────────╮
    │ change        │ review │ next step │
    ├───────────────┼────────┼───────────┤
    │ gadget        │        │ landed    │
    │ └─ gizmo      │      2 │ review    │
    │ widgets       │        │ land      │
    │ their-feature │      3 │ import    │
    ╰───────────────┴────────┴───────────╯"
  `);
  // A tree entry's row resolves to that change, with the link on exactly the
  // name: the guide and the table chrome stay plain.
  const line = docText(doc)
    .split("\n")
    .findIndex((text) => text.includes("└─ gizmo"));
  expect(targetAt(doc, line)).toEqual({ kind: "change", change: "gizmo" });
  expect(doc.lines[line]?.spans.filter(({ target }) => target !== undefined)).toEqual([
    { text: "gizmo", style: undefined, target: { kind: "change", change: "gizmo" }, tier: "link" },
  ]);
  // An unimported request's row resolves to the request.
  const requestLine = docText(doc)
    .split("\n")
    .findIndex((text) => text.includes("their-feature"));
  expect(targetAt(doc, requestLine)).toEqual({ kind: "request", request: 7, change: "their-feature" });
});

test("todoDoc with nothing to do says so", () => {
  expect(docText(todoDoc({ review: [], owned: [] }))).toMatchInlineSnapshot(`"Nothing to do."`);
});

test("showDoc renders the attribute table and files left", () => {
  const doc = showDoc({
    kind: "change",
    summary: summary("widgets", {
      forgeRequest: { forge: parseForgeLocator("github.com/test-org/widgets"), request: forgeRequestId(7) },
      reviewLeft: files("api.ts", "ui.ts"),
    }),
  });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "widgets
    =======

    ╭───────────────┬───────────────────────────────╮
    │ attribute     │ value                         │
    ├───────────────┼───────────────────────────────┤
    │ next step     │ review                        │
    │ owner         │ alice@example.com             │
    │ parent        │ main                          │
    │ forge request │ github.com/test-org/widgets#7 │
    │ tip           │ 222222222222                  │
    │ base          │ 111111111111                  │
    ╰───────────────┴───────────────────────────────╯

    Files to review:
      api.ts
      ui.ts"
  `);
  const line = docText(doc)
    .split("\n")
    .findIndex((text) => text.includes("api.ts"));
  expect(targetAt(doc, line)).toEqual({ kind: "file", change: "widgets", file: "api.ts" });
  // The heading names the page itself, so it goes nowhere.
  expect(targetAt(doc, 0)).toBeUndefined();
});

test("showDoc renders an unimported request as the change importing it would create", () => {
  const doc = showDoc({
    kind: "request",
    forge: parseForgeLocator("github.com/test-org/widgets"),
    request: {
      id: forgeRequestId(7),
      head: parseRefName("their-feature"),
      base: parseRefName("main"),
      title: "Their feature",
      author: userName("carol@users.noreply.github.com"),
      state: "open",
      changedFiles: 2,
    },
    files: files("api.ts", "ui.ts"),
  });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "their-feature
    =============

    ╭───────────────┬────────────────────────────────╮
    │ attribute     │ value                          │
    ├───────────────┼────────────────────────────────┤
    │ next step     │ import                         │
    │ owner         │ carol@users.noreply.github.com │
    │ parent        │ main                           │
    │ forge request │ github.com/test-org/widgets#7  │
    │ title         │ Their feature                  │
    ╰───────────────┴────────────────────────────────╯

    Files to review:
      api.ts
      ui.ts"
  `);
  // The heading resolves to the request, so import actions find it from
  // anywhere on the page — but as a jump, not an advertised link to itself.
  expect(targetAt(doc, 0)).toEqual({ kind: "request", request: 7, change: "their-feature" });
  expect(doc.lines[0]?.spans[0]?.tier).toBe("jump");
  // File rows carry no targets: there are no diffs to open until the import.
  const line = docText(doc)
    .split("\n")
    .findIndex((text) => text.includes("api.ts"));
  expect(targetAt(doc, line)).toBeUndefined();
});

test("showDoc renders a landed change without a files section", () => {
  const doc = showDoc({ kind: "change", summary: summary("widgets", { landed: fake("5"), nextStep: "landed" }) });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "widgets
    =======

    ╭───────────┬───────────────────╮
    │ attribute │ value             │
    ├───────────┼───────────────────┤
    │ next step │ landed            │
    │ owner     │ alice@example.com │
    │ parent    │ main              │
    │ landed    │ 555555555555      │
    │ tip       │ 222222222222      │
    │ base      │ 111111111111      │
    ╰───────────┴───────────────────╯"
  `);
});

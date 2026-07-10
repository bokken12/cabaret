import {
  type ChangeSummary,
  type CommitHash,
  type ForgeChange,
  forgeChangeId,
  parseCommitHash,
  parseFilePath,
  parseForgeLocator,
  parseRefName,
  timestampMs,
  userName,
} from "cabaret-core";
import { expect, test } from "vitest";
import { docText, foldDoc, showDoc, type TodoItem, targetAt, todoDoc } from "../index.js";

function fake(digit: string): CommitHash {
  return parseCommitHash(digit.repeat(40));
}

const alice = userName("alice@example.com");

function summary(change: string, opts: Partial<ChangeSummary>): ChangeSummary {
  return {
    change: parseRefName(change),
    parent: parseRefName("main"),
    owner: alice,
    forgeChange: undefined,
    landed: undefined,
    base: fake("1"),
    tip: fake("2"),
    origin: undefined,
    deadParent: undefined,
    staleBase: undefined,
    reviewLeft: [],
    nextStep: "review",
    ...opts,
  };
}

const files = (...names: string[]) => names.map(parseFilePath);

test("todoDoc lays out the review table and the owned tree, forge changes standing in as changes", () => {
  const change = (summary: ChangeSummary): TodoItem => ({ kind: "change", summary });
  const gadget = summary("gadget", { landed: fake("5"), nextStep: "landed", tip: fake("3") });
  const gizmo = summary("gizmo", {
    parent: parseRefName("gadget"),
    reviewLeft: files("gizmo.ts", "shared.ts"),
    base: fake("3"),
    tip: fake("4"),
  });
  const widgets = summary("widgets", { reviewLeft: [], nextStep: "land" });
  const forgeChange: ForgeChange = {
    id: forgeChangeId(7),
    head: parseRefName("their-feature"),
    tip: fake("7"),
    parent: parseRefName("main"),
    title: "Their feature",
    author: alice,
    state: "open",
    changedFiles: 3,
  };
  const doc = todoDoc({
    review: [change(gizmo), { kind: "forge-change", change: forgeChange }],
    owned: [
      { item: change(gadget), children: [{ item: change(gizmo), children: [] }] },
      { item: change(widgets), children: [] },
      { item: { kind: "forge-change", change: forgeChange }, children: [] },
    ],
    forge: {
      locator: parseForgeLocator("github.com/test-org/widgets"),
      takenAt: timestampMs(Date.UTC(2025, 5, 15, 15, 6, 40)),
    },
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
    ╰───────────────┴────────┴───────────╯

    github.com/test-org/widgets synced 2025-06-15T15:06:40.000Z"
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
  // An unimported forge change's row resolves to it.
  const forgeChangeLine = docText(doc)
    .split("\n")
    .findIndex((text) => text.includes("their-feature"));
  expect(targetAt(doc, forgeChangeLine)).toEqual({ kind: "forge-change", id: 7, change: "their-feature" });
});

test("todoDoc with nothing to do says so", () => {
  expect(docText(todoDoc({ review: [], owned: [] }))).toMatchInlineSnapshot(`"Nothing to do."`);
});

test("showDoc renders the attribute table, remaining review, and files left", () => {
  const doc = showDoc({
    kind: "change",
    summary: summary("widgets", {
      forgeChange: { forge: parseForgeLocator("github.com/test-org/widgets"), id: forgeChangeId(7) },
      reviewLeft: files("api.ts", "ui.ts"),
    }),
    comments: [],
    remaining: ["alice@example.com: 2 files", "bob@example.com: 1 file"],
  });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "widgets
    =======

    ╭──────────────┬───────────────────────────────╮
    │ attribute    │ value                         │
    ├──────────────┼───────────────────────────────┤
    │ next step    │ review                        │
    │ owner        │ alice@example.com             │
    │ parent       │ main                          │
    │ forge change │ github.com/test-org/widgets#7 │
    │ tip          │ 222222222222                  │
    │ base         │ 111111111111                  │
    ╰──────────────┴───────────────────────────────╯

    Remaining review:
      alice@example.com: 2 files
      bob@example.com: 1 file

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

test("showDoc notes disagreeing readings on their own rows", () => {
  const doc = showDoc({
    kind: "change",
    summary: summary("widgets", {
      reviewLeft: files("api.ts"),
      origin: "behind",
      staleBase: "behind",
      nextStep: "sync",
    }),
    comments: [],
    remaining: ["alice@example.com: 1 file"],
  });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "widgets
    =======

    ╭───────────┬──────────────────────────────╮
    │ attribute │ value                        │
    ├───────────┼──────────────────────────────┤
    │ next step │ sync                         │
    │ owner     │ alice@example.com            │
    │ parent    │ main                         │
    │ tip       │ 222222222222 (behind origin) │
    │ base      │ 111111111111 (behind parent) │
    ╰───────────┴──────────────────────────────╯

    Remaining review:
      alice@example.com: 1 file

    Files to review:
      api.ts"
  `);
});

test("showDoc words each note by its reading", () => {
  const attributeRow = (opts: Partial<ChangeSummary>, attribute: string) => {
    const doc = showDoc({
      kind: "change",
      summary: summary("widgets", { parent: parseRefName("gadget"), ...opts }),
      comments: [],
      remaining: [],
    });
    return docText(doc)
      .split("\n")
      .find((line) => line.startsWith(`│ ${attribute}`));
  };
  expect(attributeRow({ origin: "ahead" }, "tip")).toBe("│ tip       │ 222222222222 (ahead of origin) │");
  expect(attributeRow({ origin: "behind" }, "tip")).toBe("│ tip       │ 222222222222 (behind origin) │");
  expect(attributeRow({ origin: "diverged" }, "tip")).toBe("│ tip       │ 222222222222 (diverged from origin) │");
  expect(attributeRow({ deadParent: "landed" }, "parent")).toBe("│ parent    │ gadget (landed)   │");
  expect(attributeRow({ deadParent: "missing" }, "parent")).toBe("│ parent    │ gadget (does not exist) │");
  expect(attributeRow({ staleBase: "behind" }, "base")).toBe("│ base      │ 111111111111 (behind parent) │");
  expect(attributeRow({ staleBase: "diverged" }, "base")).toBe("│ base      │ 111111111111 (diverged from parent) │");
  // Readings that agree with what they track go unannotated.
  expect(attributeRow({}, "tip")).toBe("│ tip       │ 222222222222      │");
  expect(attributeRow({}, "parent")).toBe("│ parent    │ gadget            │");
  expect(attributeRow({}, "base")).toBe("│ base      │ 111111111111      │");
});

test("showDoc renders an unimported forge change as the change importing it would create", () => {
  const doc = showDoc({
    kind: "forge-change",
    forge: parseForgeLocator("github.com/test-org/widgets"),
    change: {
      id: forgeChangeId(7),
      head: parseRefName("their-feature"),
      tip: fake("7"),
      parent: parseRefName("main"),
      title: "Their feature",
      author: userName("carol@users.noreply.github.com"),
      state: "open",
      changedFiles: 2,
    },
    files: files("api.ts", "ui.ts"),
    comments: [
      {
        timestamp: timestampMs(Date.UTC(2025, 5, 15, 15, 6, 40)),
        user: userName("carol@users.noreply.github.com"),
        text: "please take a look",
      },
    ],
  });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "their-feature
    =============

    ╭──────────────┬────────────────────────────────╮
    │ attribute    │ value                          │
    ├──────────────┼────────────────────────────────┤
    │ next step    │ import                         │
    │ owner        │ carol@users.noreply.github.com │
    │ parent       │ main                           │
    │ forge change │ github.com/test-org/widgets#7  │
    │ title        │ Their feature                  │
    ╰──────────────┴────────────────────────────────╯

    Comments:
      2025-06-15T15:06:40.000Z carol@users.noreply.github.com
        please take a look

    Files to review:
      api.ts
      ui.ts"
  `);
  // The heading resolves to the forge change, so import actions find it from
  // anywhere on the page — but as a jump, not an advertised link to itself.
  expect(targetAt(doc, 0)).toEqual({ kind: "forge-change", id: 7, change: "their-feature" });
  expect(doc.lines[0]?.spans[0]?.tier).toBe("jump");
  // File rows carry no targets: there are no diffs to open until the import.
  const line = docText(doc)
    .split("\n")
    .findIndex((text) => text.includes("api.ts"));
  expect(targetAt(doc, line)).toBeUndefined();
});

test("showDoc renders comments between the remaining review and the files, multi-line text indented", () => {
  const doc = showDoc({
    kind: "change",
    summary: summary("gadget", { reviewLeft: files("gadget.ts") }),
    remaining: ["bob@example.com: 1 file"],
    comments: [
      {
        timestamp: timestampMs(Date.UTC(2025, 4, 23, 11, 33, 20, 3)),
        user: alice,
        text: "does this handle empty diffs?",
      },
      {
        timestamp: timestampMs(Date.UTC(2025, 4, 23, 11, 33, 20, 4)),
        user: userName("bob@example.com"),
        text: "second thoughts:\n\nthe flag name reads oddly",
      },
    ],
  });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "gadget
    ======

    ╭───────────┬───────────────────╮
    │ attribute │ value             │
    ├───────────┼───────────────────┤
    │ next step │ review            │
    │ owner     │ alice@example.com │
    │ parent    │ main              │
    │ tip       │ 222222222222      │
    │ base      │ 111111111111      │
    ╰───────────┴───────────────────╯

    Remaining review:
      bob@example.com: 1 file

    Comments:
      2025-05-23T11:33:20.003Z alice@example.com
        does this handle empty diffs?

      2025-05-23T11:33:20.004Z bob@example.com
        second thoughts:

        the flag name reads oddly

    Files to review:
      gadget.ts"
  `);
});

test("showDoc renders a landed change without a files section", () => {
  const doc = showDoc({
    kind: "change",
    summary: summary("widgets", { landed: fake("5"), nextStep: "landed" }),
    comments: [],
    remaining: [],
  });
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

test("todoDoc sections each owned subtree under its root's row", () => {
  const change = (summary: ChangeSummary): TodoItem => ({ kind: "change", summary });
  const doc = todoDoc({
    review: [],
    owned: [
      {
        item: change(summary("gadget", { nextStep: "land" })),
        children: [
          {
            item: change(summary("gizmo", { parent: parseRefName("gadget"), base: fake("3") })),
            children: [
              { item: change(summary("doohickey", { parent: parseRefName("gizmo"), base: fake("4") })), children: [] },
            ],
          },
        ],
      },
      { item: change(summary("widgets", { nextStep: "land" })), children: [] },
    ],
  });
  expect(docText(foldDoc(doc, new Set(["gizmo"])))).toMatchInlineSnapshot(`
    "Changes you own:
    ╭─────────────────┬────────┬───────────╮
    │ change          │ review │ next step │
    ├─────────────────┼────────┼───────────┤
    │ gadget          │        │ land      │
    │ └─ gizmo        │        │ review    │ …
    │ widgets         │        │ land      │
    ╰─────────────────┴────────┴───────────╯"
  `);
  expect(docText(foldDoc(doc, new Set(["gadget"])))).toMatchInlineSnapshot(`
    "Changes you own:
    ╭─────────────────┬────────┬───────────╮
    │ change          │ review │ next step │
    ├─────────────────┼────────┼───────────┤
    │ gadget          │        │ land      │ …
    │ widgets         │        │ land      │
    ╰─────────────────┴────────┴───────────╯"
  `);
});

test("showDoc sections fold under their headings, leaving their neighbors whole", () => {
  const doc = showDoc({
    kind: "change",
    summary: summary("widgets", { reviewLeft: files("api.ts", "ui.ts") }),
    comments: [{ timestamp: timestampMs(Date.UTC(2025, 5, 15, 15, 6, 40)), user: alice, text: "looks close\none nit" }],
    remaining: ["alice@example.com: 2 files"],
  });
  expect(docText(foldDoc(doc, new Set(["Remaining review:", "Comments:"])))).toMatchInlineSnapshot(`
    "widgets
    =======

    ╭───────────┬───────────────────╮
    │ attribute │ value             │
    ├───────────┼───────────────────┤
    │ next step │ review            │
    │ owner     │ alice@example.com │
    │ parent    │ main              │
    │ tip       │ 222222222222      │
    │ base      │ 111111111111      │
    ╰───────────┴───────────────────╯

    Remaining review: …

    Comments: …

    Files to review:
      api.ts
      ui.ts"
  `);
});

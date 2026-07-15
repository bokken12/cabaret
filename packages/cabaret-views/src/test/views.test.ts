import {
  type ChangeSummary,
  type CommitHash,
  forgeChangeId,
  parseCommitHash,
  parseFilePath,
  parseForgeLocator,
  parseRefName,
  timestampMs,
  userName,
} from "cabaret-core";
import { expect, test } from "vitest";
import { type Doc, docText, foldedText, showDoc, targetAt, todoDoc } from "../index.js";

function fake(digit: string): CommitHash {
  return parseCommitHash(digit.repeat(40));
}

const alice = userName("alice@example.com");

function summary(change: string, opts: Partial<ChangeSummary>): ChangeSummary {
  return {
    change: parseRefName(change),
    parent: parseRefName("main"),
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: undefined,
    landed: undefined,
    base: fake("1"),
    tip: fake("2"),
    origin: undefined,
    deadParent: undefined,
    staleBase: undefined,
    conflicts: [],
    reviewLeft: [],
    nextStep: "review",
    ...opts,
  };
}

const files = (...names: string[]) => names.map(parseFilePath);

/** Each fold as the text of the lines it runs from and to, and whether it starts folded. */
function foldTexts(doc: Doc): { from: string | undefined; to: string | undefined; folded: boolean }[] {
  const text = docText(doc).split("\n");
  return doc.folds.map(({ start, end, folded }) => ({ from: text[start], to: text[end], folded }));
}

test("todoDoc lays out both sections as trees, ancestors kept for context", () => {
  const gadget = summary("gadget", { landed: fake("5"), nextStep: "landed", tip: fake("3") });
  const gizmo = summary("gizmo", {
    parent: parseRefName("gadget"),
    reviewLeft: files("gizmo.ts", "shared.ts"),
    base: fake("3"),
    tip: fake("4"),
  });
  const widgets = summary("widgets", { reviewLeft: [], nextStep: "land" });
  const doc = todoDoc({
    review: [
      { summary: gadget, owed: [], children: [{ summary: gizmo, owed: files("gizmo.ts", "shared.ts"), children: [] }] },
    ],
    owned: [
      { summary: gadget, context: true, children: [{ summary: gizmo, context: false, children: [] }] },
      { summary: widgets, context: false, children: [] },
    ],
    broken: [],
    workspaces: new Map(),
  });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "Todo
    ====

    Changes to review:
    ╭──────────┬────────╮
    │ change   │ review │
    ├──────────┼────────┤
    │ gadget   │        │
    │ └─ gizmo │      2 │
    ╰──────────┴────────╯

    Changes you own:
    ╭──────────┬────────┬───────────╮
    │ change   │ review │ next step │
    ├──────────┼────────┼───────────┤
    │ gadget   │        │ landed    │
    │ └─ gizmo │      2 │ review    │
    │ widgets  │        │ land      │
    ╰──────────┴────────┴───────────╯"
  `);
  // Each section folds down to its heading, and within each table gadget's
  // subtree folds down to gadget's own row.
  expect(foldTexts(doc)).toEqual([
    { from: "Changes to review:", to: "╰──────────┴────────╯", folded: false },
    { from: "│ gadget   │        │", to: "│ └─ gizmo │      2 │", folded: false },
    { from: "Changes you own:", to: "╰──────────┴────────┴───────────╯", folded: false },
    { from: "│ gadget   │        │ landed    │", to: "│ └─ gizmo │      2 │ review    │", folded: false },
  ]);
  // A tree entry's row resolves to that change, with the link on exactly the
  // name: the guide and the table chrome stay plain.
  const line = docText(doc)
    .split("\n")
    .findIndex((text) => text.includes("└─ gizmo"));
  expect(targetAt(doc, line)).toEqual({ kind: "change", change: "gizmo" });
  expect(doc.lines[line]?.spans.filter(({ target }) => target !== undefined)).toEqual([
    { text: "gizmo", style: undefined, target: { kind: "change", change: "gizmo" }, tier: "link" },
  ]);
  // An ancestor kept only for context dims — its whole row, link included —
  // while the change actually owed keeps plain paint.
  const styled = (row: string) =>
    doc.lines[docText(doc).split("\n").indexOf(row)]?.spans.filter(({ style }) => style !== undefined);
  expect(styled("│ gadget   │        │")).toEqual([
    { text: "gadget", style: "context", target: { kind: "change", change: "gadget" }, tier: "link" },
  ]);
  expect(styled("│ └─ gizmo │      2 │")).toEqual([]);
  expect(styled("│ gadget   │        │ landed    │")).toEqual([
    { text: "gadget", style: "context", target: { kind: "change", change: "gadget" }, tier: "link" },
    { text: "", style: "context", target: undefined, tier: undefined },
    { text: "landed", style: "context", target: undefined, tier: undefined },
  ]);
});

test("todoDoc with nothing to do keeps both sections, empty", () => {
  expect(docText(todoDoc({ review: [], owned: [], broken: [], workspaces: new Map() }))).toMatchInlineSnapshot(`
    "Todo
    ====

    Changes to review:
    ╭────────┬────────╮
    │ change │ review │
    ├────────┼────────┤
    ╰────────┴────────╯

    Changes you own:
    ╭────────┬────────┬───────────╮
    │ change │ review │ next step │
    ├────────┼────────┼───────────┤
    ╰────────┴────────┴───────────╯"
  `);
});

test("todoDoc notes a change's workspace on its row, dimmed and resolving to the directory", () => {
  const gadget = summary("gadget", { reviewLeft: files("gadget.ts") });
  const relic = summary("relic", { landed: fake("5"), nextStep: "landed", tip: fake("3") });
  const doc = todoDoc({
    review: [{ summary: gadget, owed: files("gadget.ts"), children: [] }],
    owned: [
      { summary: gadget, context: false, children: [] },
      { summary: relic, context: true, children: [] },
    ],
    broken: [],
    workspaces: new Map([
      [gadget.change, { path: "/src/widgets-gadget", display: "../widgets-gadget", dirty: true, primary: false }],
      [relic.change, { path: "/src/widgets-relic", display: "../widgets-relic", dirty: false, primary: false }],
    ]),
  });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "Todo
    ====

    Changes to review:
    ╭──────────────────────────────────────┬────────╮
    │ change                               │ review │
    ├──────────────────────────────────────┼────────┤
    │ gadget (at ../widgets-gadget, dirty) │      1 │
    ╰──────────────────────────────────────┴────────╯

    Changes you own:
    ╭──────────────────────────────────────┬────────┬───────────╮
    │ change                               │ review │ next step │
    ├──────────────────────────────────────┼────────┼───────────┤
    │ gadget (at ../widgets-gadget, dirty) │      1 │ review    │
    │ relic (at ../widgets-relic)          │        │ landed    │
    ╰──────────────────────────────────────┴────────┴───────────╯"
  `);
  // The name still links to the change; the note is dimmed and resolves to
  // the workspace's directory.
  const line = docText(doc)
    .split("\n")
    .findIndex((text) => text.includes("relic"));
  expect(doc.lines[line]?.spans.filter(({ target }) => target !== undefined)).toEqual([
    { text: "relic", style: "context", target: { kind: "change", change: "relic" }, tier: "link" },
    {
      text: " (at ../widgets-relic)",
      style: "context",
      target: { kind: "workspace", path: "/src/widgets-relic" },
      tier: "link",
    },
  ]);
});

test("todoDoc carries broken changes as doc errors, named for their change", () => {
  const doc = todoDoc({
    review: [],
    owned: [{ summary: summary("widgets", {}), context: false, children: [] }],
    broken: [
      { change: parseRefName("gizmo"), message: 'unknown revision: "refs/heads/gizmo"' },
      { change: parseRefName("relic"), message: 'parent branch of "relic" does not exist: "gone"' },
    ],
    workspaces: new Map(),
  });
  expect(doc.errors).toEqual([
    'gizmo: unknown revision: "refs/heads/gizmo"',
    'relic: parent branch of "relic" does not exist: "gone"',
  ]);
  // The tables show only what could be read; broken changes stay off them.
  expect(docText(doc)).toMatchInlineSnapshot(`
    "Todo
    ====

    Changes to review:
    ╭────────┬────────╮
    │ change │ review │
    ├────────┼────────┤
    ╰────────┴────────╯

    Changes you own:
    ╭─────────┬────────┬───────────╮
    │ change  │ review │ next step │
    ├─────────┼────────┼───────────┤
    │ widgets │        │ review    │
    ╰─────────┴────────┴───────────╯"
  `);
});

test("showDoc renders the attribute table, remaining review, and files left", () => {
  const doc = showDoc({
    summary: summary("widgets", {
      reviewers: [userName("bob@example.com"), userName("carol@example.com")],
      forgeChange: { forge: parseForgeLocator("github.com/test-org/widgets"), id: forgeChangeId(7) },
      reviewLeft: files("api.ts", "ui.ts"),
    }),
    comments: [],
    workspace: undefined,
    remaining: [
      { user: alice, files: files("api.ts", "ui.ts") },
      { user: userName("bob@example.com"), files: files("api.ts") },
    ],
  });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "widgets
    =======

    ╭──────────────┬────────────────────────────────────╮
    │ attribute    │ value                              │
    ├──────────────┼────────────────────────────────────┤
    │ next step    │ review                             │
    │ owner        │ alice@example.com                  │
    │ reviewers    │ bob@example.com, carol@example.com │
    │ reviewing    │ everyone                           │
    │ parent       │ main                               │
    │ forge change │ github.com/test-org/widgets#7      │
    │ tip          │ 222222222222                       │
    │ base         │ 111111111111                       │
    ╰──────────────┴────────────────────────────────────╯

    Remaining review:
      alice@example.com: 2 files
        api.ts
        ui.ts
      bob@example.com: 1 file
        api.ts

    Files to review:
      api.ts
      ui.ts"
  `);
  // Each reviewer's tally folds open to their files, starting folded; hosts
  // that cannot unfold show the tallies alone.
  expect(foldTexts(doc)).toEqual([
    { from: "Remaining review:", to: "    api.ts", folded: false },
    { from: "  alice@example.com: 2 files", to: "    ui.ts", folded: true },
    { from: "  bob@example.com: 1 file", to: "    api.ts", folded: true },
    { from: "Files to review:", to: "  ui.ts", folded: false },
  ]);
  expect(foldedText(doc)).toMatchInlineSnapshot(`
    "widgets
    =======

    ╭──────────────┬────────────────────────────────────╮
    │ attribute    │ value                              │
    ├──────────────┼────────────────────────────────────┤
    │ next step    │ review                             │
    │ owner        │ alice@example.com                  │
    │ reviewers    │ bob@example.com, carol@example.com │
    │ reviewing    │ everyone                           │
    │ parent       │ main                               │
    │ forge change │ github.com/test-org/widgets#7      │
    │ tip          │ 222222222222                       │
    │ base         │ 111111111111                       │
    ╰──────────────┴────────────────────────────────────╯

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
    summary: summary("widgets", {
      reviewLeft: files("api.ts"),
      origin: "behind",
      staleBase: "behind",
      nextStep: "sync",
    }),
    comments: [],
    workspace: undefined,
    remaining: [{ user: alice, files: files("api.ts") }],
  });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "widgets
    =======

    ╭───────────┬──────────────────────────────╮
    │ attribute │ value                        │
    ├───────────┼──────────────────────────────┤
    │ next step │ sync                         │
    │ owner     │ alice@example.com            │
    │ reviewing │ everyone                     │
    │ parent    │ main                         │
    │ tip       │ 222222222222 (behind origin) │
    │ base      │ 111111111111 (behind parent) │
    ╰───────────┴──────────────────────────────╯

    Remaining review:
      alice@example.com: 1 file
        api.ts

    Files to review:
      api.ts"
  `);
});

test("showDoc words each note by its reading", () => {
  const attributeRow = (opts: Partial<ChangeSummary>, attribute: string) => {
    const doc = showDoc({
      summary: summary("widgets", { parent: parseRefName("gadget"), ...opts }),
      comments: [],
      workspace: undefined,
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

test("showDoc renders comments between the remaining review and the files, multi-line text indented", () => {
  const doc = showDoc({
    summary: summary("gadget", { reviewLeft: files("gadget.ts") }),
    remaining: [{ user: userName("bob@example.com"), files: files("gadget.ts") }],
    workspace: undefined,
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
    │ reviewing │ everyone          │
    │ parent    │ main              │
    │ tip       │ 222222222222      │
    │ base      │ 111111111111      │
    ╰───────────┴───────────────────╯

    Remaining review:
      bob@example.com: 1 file
        gadget.ts

    Comments:
      2025-05-23T11:33:20.003Z alice@example.com
        does this handle empty diffs?

      2025-05-23T11:33:20.004Z bob@example.com
        second thoughts:

        the flag name reads oddly

    Files to review:
      gadget.ts"
  `);
  // A fold runs to its section's true end: the comments' internal blank
  // lines fold away with them.
  expect(foldTexts(doc)).toEqual([
    { from: "Remaining review:", to: "    gadget.ts", folded: false },
    { from: "  bob@example.com: 1 file", to: "    gadget.ts", folded: true },
    { from: "Comments:", to: "    the flag name reads oddly", folded: false },
    { from: "Files to review:", to: "  gadget.ts", folded: false },
  ]);
});

test("showDoc rows the change's workspace, noting dirtiness", () => {
  const workspaceRow = (dirty: boolean) => {
    const doc = showDoc({
      summary: summary("widgets", {}),
      comments: [],
      workspace: { path: "/src/widgets-tree", display: "../widgets-tree", dirty, primary: false },
      remaining: [],
    });
    return docText(doc)
      .split("\n")
      .find((line) => line.startsWith("│ workspace"));
  };
  expect(workspaceRow(false)).toBe("│ workspace │ ../widgets-tree   │");
  expect(workspaceRow(true)).toBe("│ workspace │ ../widgets-tree (dirty) │");
});

test("showDoc renders a landed change without a files section", () => {
  const doc = showDoc({
    summary: summary("widgets", { landed: fake("5"), nextStep: "landed" }),
    comments: [],
    workspace: undefined,
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
  expect(doc.folds).toEqual([]);
});

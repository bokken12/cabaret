import {
  type ChangeSummary,
  forgeChangeId,
  parseBranchName,
  parseCommitHash,
  parseFilePath,
  parseForgeLocator,
  type Revision,
  timestampMs,
  type UserName,
  userName,
} from "cabaret-core";
import { expect, test } from "vitest";
import { type Doc, docText, homeDoc, showDoc, targetAt } from "../index.js";

function fake(digit: string): Revision {
  return parseCommitHash(digit.repeat(40));
}

const alice = userName("alice@example.com");

function summary(change: string, opts: Partial<ChangeSummary>): ChangeSummary {
  return {
    kind: "change",
    change: parseBranchName(change),
    parent: parseBranchName("main"),
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: undefined,
    landed: undefined,
    included: [],
    archived: false,
    base: fake("1"),
    tip: fake("2"),
    origin: undefined,
    deadParent: undefined,
    parentOrigin: undefined,
    staleBase: undefined,
    conflicts: [],
    reviewLeft: [],
    nextStep: "review",
    ...opts,
  };
}

const files = (...names: string[]) => names.map(parseFilePath);
/** `reviewLeft` entries; "old.ts -> new.ts" names a move, "old.ts => new.ts" a copy. */
const left = (...names: string[]) =>
  names.map((name) => {
    const arrow = name.includes(" => ") ? " => " : " -> ";
    const [from, to] = name.split(arrow);
    return from !== undefined && to !== undefined
      ? { path: parseFilePath(to), source: { path: parseFilePath(from), copied: arrow === " => " } }
      : { path: parseFilePath(name), source: undefined };
  });

/** Each fold as the text of the lines it runs from and to. */
function foldTexts(doc: Doc): (string | undefined)[][] {
  const text = docText(doc).split("\n");
  return doc.folds.map(({ start, end }) => [text[start], text[end]]);
}

test("homeDoc lays out both sections as trees, ancestors kept for context", () => {
  const gadget = summary("gadget", { landed: fake("5"), nextStep: "landed", tip: fake("3") });
  const gizmo = summary("gizmo", {
    parent: parseBranchName("gadget"),
    reviewLeft: left("gizmo.ts", "shared.ts"),
    base: fake("3"),
    tip: fake("4"),
  });
  const widgets = summary("widgets", { reviewLeft: [], nextStep: "land" });
  const rusty = summary("rusty", { conflicts: files("rusty.ts"), nextStep: "fix conflicts" });
  const doc = homeDoc({
    as: undefined,
    review: [
      { summary: gadget, owed: [], children: [{ summary: gizmo, owed: files("gizmo.ts", "shared.ts"), children: [] }] },
    ],
    owned: [
      { summary: gadget, context: true, children: [{ summary: gizmo, context: false, children: [] }] },
      { summary: rusty, context: false, children: [] },
      { summary: widgets, context: false, children: [] },
    ],
    broken: [],
    workspaces: [],
    fetched: undefined,
  });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "Home
    ====

    Changes to review:
    ╭──────────┬────────╮
    │ change   │ review │
    ├──────────┼────────┤
    │ gadget   │        │
    │ └─ gizmo │      2 │
    ╰──────────┴────────╯

    Changes you own:
    ╭──────────┬───────────────╮
    │ change   │ next step     │
    ├──────────┼───────────────┤
    │ gadget   │ landed        │
    │ └─ gizmo │ review        │
    │ rusty    │ fix conflicts │
    │ widgets  │ land          │
    ╰──────────┴───────────────╯"
  `);
  // Each section folds down to its heading, and within each table gadget's
  // subtree folds down to gadget's own row.
  expect(foldTexts(doc)).toEqual([
    ["Changes to review:", "╰──────────┴────────╯"],
    ["│ gadget   │        │", "│ └─ gizmo │      2 │"],
    ["Changes you own:", "╰──────────┴───────────────╯"],
    ["│ gadget   │ landed        │", "│ └─ gizmo │ review        │"],
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
  expect(styled("│ gadget   │ landed        │")).toEqual([
    { text: "gadget", style: "context", target: { kind: "change", change: "gadget" }, tier: "link" },
    { text: "landed", style: "context", target: undefined, tier: undefined },
  ]);
  // The steps where action matters most catch the eye — the change's name
  // in the same paint as its step: a change ready to land, and conflicts
  // blocking the work stacked on it.
  expect(styled("│ widgets  │ land          │")).toEqual([
    { text: "widgets", style: "ready", target: { kind: "change", change: "widgets" }, tier: "link" },
    { text: "land", style: "ready", target: { kind: "action", change: "widgets", action: "land" }, tier: "link" },
  ]);
  expect(styled("│ rusty    │ fix conflicts │")).toEqual([
    { text: "rusty", style: "blocked", target: { kind: "change", change: "rusty" }, tier: "link" },
    { text: "fix conflicts", style: "blocked", target: undefined, tier: undefined },
  ]);
});

test("homeDoc with nothing to do keeps both sections, empty", () => {
  expect(
    docText(homeDoc({ as: undefined, review: [], owned: [], broken: [], workspaces: [], fetched: undefined })),
  ).toMatchInlineSnapshot(`
    "Home
    ====

    Changes to review:
    ╭────────┬────────╮
    │ change │ review │
    ├────────┼────────┤
    ╰────────┴────────╯

    Changes you own:
    ╭────────┬───────────╮
    │ change │ next step │
    ├────────┼───────────┤
    ╰────────┴───────────╯"
  `);
});

test("homeDoc lists the changes checked out on this device in their stacks", () => {
  const gadget = summary("gadget", { reviewLeft: left("gadget.ts") });
  const widgets = summary("widgets", {});
  const relic = summary("relic", {
    parent: parseBranchName("widgets"),
    landed: fake("5"),
    nextStep: "landed",
    tip: fake("3"),
  });
  const doc = homeDoc({
    as: undefined,
    review: [{ summary: gadget, owed: files("gadget.ts"), children: [] }],
    owned: [{ summary: gadget, context: false, children: [] }],
    broken: [],
    workspaces: [
      {
        change: gadget.change,
        held: { workspace: { path: "/src/widgets", display: ".", dirty: false }, landed: false, archived: false },
        children: [],
      },
      {
        change: widgets.change,
        held: undefined,
        children: [
          {
            change: relic.change,
            held: {
              workspace: { path: "/src/widgets-relic", display: "../widgets-relic", dirty: true },
              landed: true,
              archived: false,
            },
            children: [],
          },
        ],
      },
    ],
    fetched: undefined,
  });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "Home
    ====

    Changes to review:
    ╭────────┬────────╮
    │ change │ review │
    ├────────┼────────┤
    │ gadget │      1 │
    ╰────────┴────────╯

    Changes you own:
    ╭────────┬───────────╮
    │ change │ next step │
    ├────────┼───────────┤
    │ gadget │ review    │
    ╰────────┴───────────╯

    Workspaces on this device:
    ╭──────────┬───────────────╮
    │ change   │ note          │
    ├──────────┼───────────────┤
    │ gadget   │               │
    │ widgets  │               │
    │ └─ relic │ dirty, landed │
    ╰──────────┴───────────────╯"
  `);
  // The section folds like the others, and so does widgets' subtree.
  expect(foldTexts(doc).slice(-2)).toEqual([
    ["Workspaces on this device:", "╰──────────┴───────────────╯"],
    ["│ widgets  │               │", "│ └─ relic │ dirty, landed │"],
  ]);
  // The change links to its page; the workspace's directory stays off this
  // table, left to the workspaces page.
  const line = docText(doc)
    .split("\n")
    .findIndex((text) => text.includes("relic"));
  expect(doc.lines[line]?.spans.flatMap(({ target }) => (target === undefined ? [] : [target]))).toEqual([
    { kind: "change", change: "relic" },
  ]);
  // An ancestor kept only to situate relic dims; a landed note wears nudge
  // paint, inviting the workspace's reclaiming.
  const styled = (row: string) =>
    doc.lines[docText(doc).split("\n").indexOf(row)]?.spans.filter(({ style }) => style !== undefined);
  expect(styled("│ widgets  │               │")).toEqual([
    { text: "widgets", style: "context", target: { kind: "change", change: "widgets" }, tier: "link" },
  ]);
  expect(styled("│ └─ relic │ dirty, landed │")).toEqual([
    { text: "dirty, landed", style: "nudge", target: undefined, tier: undefined },
  ]);
});

test("homeDoc as another user names them and keeps their identity on every change link", () => {
  const gadget = summary("gadget", { owner: userName("bob@example.com"), reviewLeft: left("gadget.ts") });
  const doc = homeDoc({
    as: userName("bob@example.com"),
    review: [{ summary: gadget, owed: files("gadget.ts"), children: [] }],
    owned: [{ summary: gadget, context: false, children: [] }],
    broken: [],
    workspaces: [],
    fetched: undefined,
  });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "Home as bob@example.com
    =======================

    Changes to review:
    ╭────────┬────────╮
    │ change │ review │
    ├────────┼────────┤
    │ gadget │      1 │
    ╰────────┴────────╯

    Changes you own:
    ╭────────┬───────────╮
    │ change │ next step │
    ├────────┼───────────┤
    │ gadget │ review    │
    ╰────────┴───────────╯"
  `);
  const line = docText(doc)
    .split("\n")
    .findIndex((text) => text.includes("│ gadget │ review"));
  expect(targetAt(doc, line)).toEqual({ kind: "change", change: "gadget", as: "bob@example.com" });
});

test("homeDoc carries broken changes as doc errors, named for their change", () => {
  const doc = homeDoc({
    as: undefined,
    review: [],
    owned: [{ summary: summary("widgets", {}), context: false, children: [] }],
    broken: [
      { change: parseBranchName("gizmo"), message: 'unknown revision: "refs/heads/gizmo"' },
      { change: parseBranchName("relic"), message: 'parent branch of "relic" does not exist: "gone"' },
    ],
    workspaces: [],
    fetched: undefined,
  });
  expect(doc.errors).toEqual([
    'gizmo: unknown revision: "refs/heads/gizmo"',
    'relic: parent branch of "relic" does not exist: "gone"',
  ]);
  // The tables show only what could be read; broken changes stay off them.
  expect(docText(doc)).toMatchInlineSnapshot(`
    "Home
    ====

    Changes to review:
    ╭────────┬────────╮
    │ change │ review │
    ├────────┼────────┤
    ╰────────┴────────╯

    Changes you own:
    ╭─────────┬───────────╮
    │ change  │ next step │
    ├─────────┼───────────┤
    │ widgets │ review    │
    ╰─────────┴───────────╯"
  `);
});

test("showDoc renders the attribute table, remaining review, and files left", () => {
  const doc = showDoc({
    as: undefined,
    summary: summary("widgets", {
      reviewers: [userName("bob@example.com"), userName("carol@example.com")],
      forgeChange: {
        forge: parseForgeLocator("github.com/test-org/widgets"),
        id: forgeChangeId(7),
        staleParent: undefined,
      },
      reviewLeft: left("lib/api.ts -> api.ts", "ui.ts"),
    }),
    comments: [],
    workspace: undefined,
    remaining: [
      { user: userName("alice@example.com"), files: 2 },
      { user: userName("bob@example.com"), files: 1 },
    ],
    fetched: undefined,
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
      bob@example.com: 1 file

    Files to review:
      lib/api.ts -> api.ts
      ui.ts"
  `);
  expect(foldTexts(doc)).toEqual([
    ["Remaining review:", "  bob@example.com: 1 file"],
    ["Files to review:", "  ui.ts"],
  ]);
  const line = docText(doc)
    .split("\n")
    .findIndex((text) => text.includes("api.ts"));
  expect(targetAt(doc, line)).toEqual({ kind: "file", change: "widgets", file: "api.ts" });
  // The forge change row opens the change's page on the forge.
  const forge = docText(doc)
    .split("\n")
    .findIndex((text) => text.includes("forge change"));
  expect(targetAt(doc, forge)).toEqual({ kind: "url", url: "https://github.com/test-org/widgets/pull/7" });
  // A remaining-review row opens that reviewer's own review page.
  const tally = docText(doc)
    .split("\n")
    .findIndex((text) => text.includes("bob@example.com: 1 file"));
  expect(targetAt(doc, tally)).toEqual({ kind: "review", change: "widgets", as: "bob@example.com" });
  // The heading names the page itself, so it goes nowhere.
  expect(targetAt(doc, 0)).toBeUndefined();
});

test("showDoc renders a trunk from its history alone, newest lands first, an ellipsis marking older ones", () => {
  const doc = showDoc({
    as: undefined,
    summary: {
      kind: "trunk",
      change: parseBranchName("main"),
      tip: fake("2"),
      origin: "behind",
      included: [
        { change: parseBranchName("gadget"), commit: fake("3"), onto: fake("1") },
        { change: parseBranchName("gizmo"), commit: fake("5"), onto: fake("4") },
      ],
      truncated: true,
    },
    comments: [],
    workspace: { path: "/src/widgets", display: ".", dirty: false },
    remaining: [],
    fetched: undefined,
  });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "main
    ====

    ╭───────────┬──────────────────────────────╮
    │ attribute │ value                        │
    ├───────────┼──────────────────────────────┤
    │ tip       │ 222222222222 (behind origin) │
    │ workspace │ .                            │
    ╰───────────┴──────────────────────────────╯

    Included changes:
      gizmo
      gadget
      …"
  `);
  // An included row opens the landed change's page; the ellipsis goes nowhere.
  const lines = docText(doc).split("\n");
  expect(
    targetAt(
      doc,
      lines.findIndex((text) => text.includes("gadget")),
    ),
  ).toEqual({
    kind: "change",
    change: "gadget",
  });
  expect(
    targetAt(
      doc,
      lines.findIndex((text) => text.includes("…")),
    ),
  ).toBeUndefined();
});

test("showDoc leaves a forge change on an unrecognized host unlinked", () => {
  const doc = showDoc({
    as: undefined,
    summary: summary("widgets", {
      forgeChange: {
        forge: parseForgeLocator("forge.example.com/test-org/widgets"),
        id: forgeChangeId(7),
        staleParent: undefined,
      },
    }),
    comments: [],
    workspace: undefined,
    remaining: [],
    fetched: undefined,
  });
  const forge = docText(doc)
    .split("\n")
    .findIndex((text) => text.includes("forge change"));
  expect(targetAt(doc, forge)).toBeUndefined();
});

test("showDoc as another user names them and keeps their identity on file and change links", () => {
  const bob = userName("bob@example.com");
  const doc = showDoc({
    summary: summary("widgets", {
      included: [{ change: parseBranchName("widgets-api"), commit: fake("3"), onto: fake("1") }],
      reviewLeft: left("api.ts"),
    }),
    as: bob,
    comments: [],
    workspace: undefined,
    remaining: [{ user: bob, files: 1 }],
    fetched: undefined,
  });
  expect(docText(doc).split("\n").slice(0, 2).join("\n")).toMatchInlineSnapshot(`
    "widgets as bob@example.com
    =========================="
  `);
  const rendered = docText(doc).split("\n");
  const targetOf = (needle: string) =>
    targetAt(
      doc,
      rendered.findIndex((text) => text.includes(needle)),
    );
  expect(targetOf("widgets-api")).toEqual({ kind: "change", change: "widgets-api", as: "bob@example.com" });
  expect(targetOf("api.ts")).toEqual({ kind: "file", change: "widgets", file: "api.ts", as: "bob@example.com" });
  expect(targetOf("bob@example.com: 1 file")).toEqual({ kind: "review", change: "widgets", as: "bob@example.com" });
});

test("showDoc lists included changes above the review, each linking to its page", () => {
  const doc = showDoc({
    as: undefined,
    summary: summary("widgets", {
      included: [
        { change: parseBranchName("widgets-api"), commit: fake("3"), onto: fake("1") },
        { change: parseBranchName("widgets-ui"), commit: fake("5"), onto: fake("3") },
      ],
      reviewLeft: left("glue.ts"),
    }),
    comments: [],
    workspace: undefined,
    remaining: [{ user: alice, files: 1 }],
    fetched: undefined,
  });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "widgets
    =======

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

    Included changes:
      widgets-ui
      widgets-api

    Remaining review:
      alice@example.com: 1 file

    Files to review:
      glue.ts"
  `);
  const line = docText(doc)
    .split("\n")
    .findIndex((text) => text.includes("widgets-ui"));
  expect(targetAt(doc, line)).toEqual({ kind: "change", change: "widgets-ui" });
  expect(targetAt(doc, line + 1)).toEqual({ kind: "change", change: "widgets-api" });
});

test("showDoc notes disagreeing readings on their own rows", () => {
  const doc = showDoc({
    as: undefined,
    summary: summary("widgets", {
      reviewLeft: left("api.ts"),
      origin: "behind",
      staleBase: "behind",
      nextStep: "sync",
    }),
    comments: [],
    workspace: undefined,
    remaining: [{ user: alice, files: 1 }],
    fetched: undefined,
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

    Files to review:
      api.ts"
  `);
});

test("showDoc words each note by its reading", () => {
  const attributeRow = (opts: Partial<ChangeSummary>, attribute: string) => {
    const doc = showDoc({
      as: undefined,
      summary: summary("widgets", { parent: parseBranchName("gadget"), ...opts }),
      comments: [],
      workspace: undefined,
      remaining: [],
      fetched: undefined,
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
  expect(attributeRow({ parentOrigin: "diverged" }, "parent")).toBe("│ parent    │ gadget (diverged from origin) │");
  expect(attributeRow({ staleBase: "behind" }, "base")).toBe("│ base      │ 111111111111 (behind parent) │");
  expect(attributeRow({ staleBase: "diverged" }, "base")).toBe("│ base      │ 111111111111 (diverged from parent) │");
  const tracked = { forge: parseForgeLocator("github.com/test-org/widgets"), id: forgeChangeId(7) };
  expect(attributeRow({ forgeChange: { ...tracked, staleParent: parseBranchName("relic") } }, "forge change")).toBe(
    "│ forge change │ github.com/test-org/widgets#7 (merges into relic) │",
  );
  expect(attributeRow({ forgeChange: { ...tracked, staleParent: undefined } }, "forge change")).toBe(
    "│ forge change │ github.com/test-org/widgets#7 │",
  );
  // Readings that agree with what they track go unannotated.
  expect(attributeRow({}, "tip")).toBe("│ tip       │ 222222222222      │");
  expect(attributeRow({}, "parent")).toBe("│ parent    │ gadget            │");
  expect(attributeRow({}, "base")).toBe("│ base      │ 111111111111      │");
});

test("showDoc links the parent row to its page, except a missing parent", () => {
  const parentTarget = (opts: Partial<ChangeSummary>, as?: UserName) => {
    const doc = showDoc({
      as,
      summary: summary("widgets", { parent: parseBranchName("gadget"), ...opts }),
      comments: [],
      workspace: undefined,
      remaining: [],
      fetched: undefined,
    });
    const line = docText(doc)
      .split("\n")
      .findIndex((text) => text.startsWith("│ parent"));
    return targetAt(doc, line);
  };
  expect(parentTarget({})).toEqual({ kind: "change", change: "gadget" });
  expect(parentTarget({ deadParent: "landed" })).toEqual({ kind: "change", change: "gadget" });
  expect(parentTarget({}, userName("bob@example.com"))).toEqual({
    kind: "change",
    change: "gadget",
    as: "bob@example.com",
  });
  expect(parentTarget({ deadParent: "missing" })).toBeUndefined();
});

test("showDoc renders comments between the remaining review and the files, multi-line text indented", () => {
  const doc = showDoc({
    as: undefined,
    summary: summary("gadget", { reviewLeft: left("gadget.ts") }),
    remaining: [{ user: userName("bob@example.com"), files: 1 }],
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
    fetched: undefined,
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
    ["Remaining review:", "  bob@example.com: 1 file"],
    ["Comments:", "    the flag name reads oddly"],
    ["Files to review:", "  gadget.ts"],
  ]);
});

test("showDoc rows the change's workspace, noting dirtiness", () => {
  const workspaceRow = (dirty: boolean) => {
    const doc = showDoc({
      as: undefined,
      summary: summary("widgets", {}),
      comments: [],
      workspace: { path: "/src/widgets-tree", display: "../widgets-tree", dirty },
      remaining: [],
      fetched: undefined,
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
    as: undefined,
    summary: summary("widgets", { landed: fake("5"), nextStep: "landed" }),
    comments: [],
    workspace: undefined,
    remaining: [],
    fetched: undefined,
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

test("each doc closes with a dimmed line dating the last fetch, when one is known", () => {
  const fetched = timestampMs(Date.UTC(2026, 6, 19, 8, 4, 5, 678));
  const footer = [{ text: "fetched 08:04, 2026-07-19", style: "context", target: undefined, tier: undefined }];
  const home = homeDoc({ as: undefined, review: [], owned: [], broken: [], workspaces: [], fetched });
  expect(docText(home)).toMatchInlineSnapshot(`
    "Home
    ====

    Changes to review:
    ╭────────┬────────╮
    │ change │ review │
    ├────────┼────────┤
    ╰────────┴────────╯

    Changes you own:
    ╭────────┬───────────╮
    │ change │ next step │
    ├────────┼───────────┤
    ╰────────┴───────────╯

    fetched 08:04, 2026-07-19"
  `);
  expect(home.lines.at(-1)?.spans).toEqual(footer);
  const show = showDoc({
    as: undefined,
    summary: summary("gizmo", { origin: "behind", nextStep: "sync" }),
    comments: [],
    workspace: undefined,
    remaining: [],
    fetched,
  });
  expect(docText(show).split("\n").slice(-2)).toEqual(["", "fetched 08:04, 2026-07-19"]);
  expect(show.lines.at(-1)?.spans).toEqual(footer);
});

test("next steps an action performs link to running it, the rest staying bare", () => {
  const doc = homeDoc({
    as: undefined,
    review: [],
    owned: [
      { summary: summary("gizmo", { nextStep: "rebase" }), context: false, children: [] },
      { summary: summary("widgets", { nextStep: "fix conflicts" }), context: false, children: [] },
    ],
    broken: [],
    workspaces: [],
    fetched: undefined,
  });
  const rows = docText(doc).split("\n");
  const targeted = (text: string) =>
    doc.lines[rows.findIndex((row) => row.includes(text))]?.spans.filter(({ target }) => target !== undefined);
  // The row's change opens its page as ever; the step is its own link.
  expect(targeted("rebase")).toEqual([
    { text: "gizmo", style: undefined, target: { kind: "change", change: "gizmo" }, tier: "link" },
    { text: "rebase", style: undefined, target: { kind: "action", change: "gizmo", action: "rebase" }, tier: "link" },
  ]);
  // Fixing conflicts is work done by hand, so the step offers nothing to run;
  // the name still wears the step's blocked paint.
  expect(targeted("fix conflicts")).toEqual([
    { text: "widgets", style: "blocked", target: { kind: "change", change: "widgets" }, tier: "link" },
  ]);
  const show = showDoc({
    as: undefined,
    summary: summary("gadget", { nextStep: "sync" }),
    comments: [],
    workspace: undefined,
    remaining: [],
    fetched: undefined,
  });
  const stepLine = docText(show)
    .split("\n")
    .findIndex((text) => text.includes("next step"));
  expect(targetAt(show, stepLine)).toEqual({ kind: "action", change: "gadget", action: "sync" });
});

test("a review next step opens the change's review, keeping a borrowed identity", () => {
  const doc = showDoc({
    as: userName("bob@example.com"),
    summary: summary("gizmo", { nextStep: "review" }),
    comments: [],
    workspace: undefined,
    remaining: [],
    fetched: undefined,
  });
  const stepLine = docText(doc)
    .split("\n")
    .findIndex((text) => text.includes("next step"));
  expect(targetAt(doc, stepLine)).toEqual({ kind: "review", change: "gizmo", as: "bob@example.com" });
});

test("a review in parent next step opens the parent's review", () => {
  const doc = showDoc({
    as: undefined,
    summary: summary("gizmo", { parent: parseBranchName("widgets"), nextStep: "review in parent" }),
    comments: [],
    workspace: undefined,
    remaining: [],
    fetched: undefined,
  });
  const stepLine = docText(doc)
    .split("\n")
    .findIndex((text) => text.includes("next step"));
  expect(targetAt(doc, stepLine)).toEqual({ kind: "review", change: "widgets" });
});

import {
  DivergedParentError,
  type FilePath,
  type FileView,
  NotReviewingError,
  parseBranchName,
  parseCommitHash,
  parseFilePath,
  UnsatisfiedObligationsError,
  type UserName,
  userName,
} from "cabaret-core";
import { type ChangeSnapshot, type Doc, layout, type Page, pagePath, section, span } from "cabaret-views";
import { expect, test } from "vitest";
import { App, type Effects, type Rendered, type Terminal } from "../app.js";

const widgets = parseBranchName("widgets");
const gadgets = parseBranchName("gadgets");
const sprockets = parseBranchName("sprockets");
const api = parseFilePath("api.ts");
const ui = parseFilePath("ui.ts");
const base = parseCommitHash("1".repeat(40));
const roundEnd = parseCommitHash("3".repeat(40));

function fileView(): FileView {
  return { kind: "span", start: base, source: undefined };
}

/** A snapshot with one round pending over `files`, reviewed by alice. */
function reviewState(files: readonly FilePath[]): ChangeSnapshot {
  return {
    change: widgets,
    user: userName("alice@example.com"),
    as: undefined,
    reviewing: "everyone",
    asked: true,
    base,
    tip: roundEnd,
    conflicts: [],
    rounds: [{ end: roundEnd, files: new Map(files.map((file) => [file, fileView()])) }],
  };
}

const home: Doc = layout([
  { spans: [span("Changes", { style: "heading" })] },
  { spans: [span("├─ "), span("widgets", { target: { kind: "change", change: widgets } })] },
  { spans: [span("├─ "), span("gadgets", { target: { kind: "change", change: gadgets } })] },
  { spans: [span("╰─ "), span("cogs", { target: { kind: "change", change: parseBranchName("cogs") } })] },
]);

const show: Doc = layout([
  { spans: [span("widgets", { style: "heading" })] },
  section({ spans: [span("Files to review")] }, [
    { spans: [span("api.ts", { target: { kind: "file", change: widgets, file: api } })] },
  ]),
]);

const reviewList: Doc = layout([
  { spans: [span("Review widgets", { style: "heading" })] },
  { spans: [span("api.ts", { target: { kind: "file", change: widgets, file: api } })] },
  { spans: [span("ui.ts", { target: { kind: "file", change: widgets, file: ui } })] },
]);

const pages = new Map<string, Doc>([
  [pagePath({ kind: "home" }), home],
  [pagePath({ kind: "show", change: widgets }), show],
  [pagePath({ kind: "show", change: gadgets }), layout([{ spans: [span("gadgets", { style: "heading" })] }])],
  [pagePath({ kind: "show", change: sprockets }), layout([{ spans: [span("sprockets", { style: "heading" })] }])],
  [
    pagePath({ kind: "show", change: parseBranchName("widget2") }),
    layout([{ spans: [span("widget2", { style: "heading" })] }]),
  ],
  [pagePath({ kind: "review", change: widgets }), reviewList],
  [
    pagePath({ kind: "diff", change: widgets, file: api }),
    layout([{ spans: [span("const a = 1;", { style: "removed" })] }]),
  ],
  [
    pagePath({ kind: "diff", change: widgets, file: ui }),
    layout([{ spans: [span("const b = 2;", { style: "added" })] }]),
  ],
]);

interface Harness {
  readonly app: App;
  readonly frames: string[][];
  /** The last frame with SGR escapes stripped, cursor gutter and all. */
  readonly screen: () => string;
  readonly keys: (...keys: readonly string[]) => Promise<readonly ("continue" | "quit")[]>;
}

function harness(overrides?: Partial<Effects>, rendered?: (page: Page) => Partial<Rendered>): Harness {
  const frames: string[][] = [];
  const terminal: Terminal = {
    columns: () => 100,
    rows: () => 7,
    depth: "ansi256",
    render: (rows) => frames.push([...rows]),
  };
  const unavailable = (what: string) => () => Promise.reject(new Error(`no ${what} in this harness`));
  const effects: Effects = {
    visitLocation: () => Promise.resolve("visited"),
    openUrl: () => Promise.resolve(undefined),
    mark: unavailable("marking"),
    parent: () => Promise.resolve(undefined),
    children: () => Promise.resolve([]),
    self: () => Promise.resolve({ user: userName("alice@example.com"), aliases: new Set<UserName>() }),
    rebase: unavailable("rebasing"),
    land: unavailable("landing"),
    rename: unavailable("renaming"),
    reparent: unavailable("reparenting"),
    setOwner: unavailable("owner transfer"),
    widenReviewing: unavailable("widening"),
    disableReviewing: unavailable("reviewing"),
    toggleArchived: unavailable("archiving"),
    gotoWorkspace: unavailable("workspaces"),
    addWorkspace: unavailable("workspaces"),
    removeWorkspace: unavailable("workspaces"),
    create: unavailable("creating"),
    changes: () => Promise.resolve([widgets, gadgets, sprockets]),
    parseName: (raw) => parseBranchName(raw),
    fetch: unavailable("fetching"),
    sync: unavailable("syncing"),
    ...overrides,
  };
  const source = (page: Page): Promise<Rendered> => {
    const doc = pages.get(pagePath(page));
    return doc === undefined
      ? Promise.reject(new Error(`no page at ${pagePath(page)}`))
      : Promise.resolve({ doc, ...rendered?.(page) });
  };
  const app = new App(source, terminal, effects);
  return {
    app,
    frames,
    screen: () => {
      const frame = frames[frames.length - 1];
      if (frame === undefined) {
        throw new Error("nothing rendered");
      }
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the escapes are what the painter emits
      return frame.map((row) => row.replaceAll(/\x1b\[[0-9;]*m/g, "")).join("\n");
    },
    keys: async (...keys) => {
      const outcomes: ("continue" | "quit")[] = [];
      for (const key of keys) {
        outcomes.push(await app.handleKey(key));
      }
      return outcomes;
    },
  };
}

test("opening home paints the page with a status row", async () => {
  const { app, screen } = harness();
  await app.open({ kind: "home" });
  expect(screen()).toMatchInlineSnapshot(`
    "❯ Changes
      ├─ widgets
      ├─ gadgets
      ╰─ cogs


     /cabaret/home                                                                                      "
  `);
});

test("enter on a change line pushes its show page; q pops back home", async () => {
  const { app, keys, screen } = harness();
  await app.open({ kind: "home" });
  await keys("j", "enter");
  expect(screen()).toMatchInlineSnapshot(`
    "❯ widgets
      Files to review
      api.ts



     /cabaret/show/widgets                                                                              "
  `);
  expect(await keys("q")).toEqual(["continue"]);
  expect(screen()).toContain("/cabaret/home");
});

test("q on the last page quits", async () => {
  const { app, keys } = harness();
  await app.open({ kind: "home" });
  expect(await keys("q")).toEqual(["quit"]);
});

test("an unbound key reports on the status row until the next key", async () => {
  const { app, keys, screen } = harness();
  await app.open({ kind: "home" });
  await keys("x");
  expect(screen()).toContain("x is undefined");
  await keys("j");
  expect(screen()).not.toContain("undefined");
});

test("tab folds the section at the cursor down to its heading", async () => {
  const { app, keys, screen } = harness();
  await app.open({ kind: "show", change: widgets });
  await keys("j", "j", "tab");
  expect(screen()).toMatchInlineSnapshot(`
    "  widgets
    ❯ Files to review …




     /cabaret/show/widgets                                                                              "
  `);
  await keys("tab");
  expect(screen()).toContain("api.ts");
});

test("enter on a location-less action-less plain line does nothing", async () => {
  const { app, keys, frames } = harness();
  await app.open({ kind: "home" });
  const before = frames.length;
  await keys("enter");
  expect(frames.length).toBe(before + 1);
});

test("a failed render reports on the status row instead of pushing a page", async () => {
  const { app, keys, screen } = harness();
  await app.open({ kind: "home" });
  await keys("j", "j", "j", "enter");
  expect(screen()).toContain("no page at /cabaret/show/cogs");
  expect(screen()).toContain("/cabaret/home");
});

test("? overlays the page's keys and any key dismisses it", async () => {
  const { app, keys, screen } = harness();
  await app.open({ kind: "home" });
  await keys("?");
  expect(screen()).toContain("Keys on this page");
  await keys("j");
  expect(screen()).not.toContain("Keys on this page");
});

test("enter on a file line routes to its diff page", async () => {
  const { app, keys, screen } = harness();
  await app.open({ kind: "show", change: widgets });
  await keys("j", "j", "enter");
  expect(screen()).toContain("/cabaret/diff/widgets:api.ts");
});

test("! m on a displayed diff page marks and moves to the round's next file", async () => {
  const calls: [FilePath, boolean][] = [];
  const snapshot = reviewState([api, ui]);
  const { app, keys, screen } = harness(
    {
      mark: (snap, file, evenThoughNotReviewing) => {
        calls.push([file, evenThoughNotReviewing]);
        return Promise.resolve({ kind: "marked", next: ui, snapshot: snap, recorded: Promise.resolve() });
      },
    },
    (page) =>
      page.kind === "diff"
        ? {
            snapshot,
            viewed: { change: widgets, user: snapshot.user, base, files: new Map([[page.file, roundEnd]]) },
          }
        : {},
  );
  await app.open({ kind: "diff", change: widgets, file: api });
  await keys("!", "m");
  expect(calls).toEqual([[api, false]]);
  expect(screen()).toContain("/cabaret/diff/widgets:ui.ts");
});

test("! m on a never-displayed file asks first; y proceeds", async () => {
  const calls: FilePath[] = [];
  const snapshot = reviewState([api, ui]);
  const { app, keys, screen } = harness(
    {
      mark: (snap, file) => {
        calls.push(file);
        return Promise.resolve({ kind: "marked", next: undefined, snapshot: snap, recorded: Promise.resolve() });
      },
    },
    (page) => (page.kind === "review" ? { snapshot } : {}),
  );
  await app.open({ kind: "review", change: widgets });
  await keys("j", "!", "m");
  expect(calls).toEqual([]);
  expect(screen()).toContain("The diff of api.ts has not been displayed to you. Mark anyway? y/n");
  await keys("y");
  expect(calls).toEqual([api]);
});

test("! m outside the reviewing set asks, then retries with the override", async () => {
  const calls: boolean[] = [];
  const snapshot = { ...reviewState([api]), reviewing: "owner", asked: false } as const satisfies ChangeSnapshot;
  const { app, keys, screen } = harness(
    {
      mark: (snap, _file, evenThoughNotReviewing) => {
        calls.push(evenThoughNotReviewing);
        if (!evenThoughNotReviewing) {
          return Promise.reject(new NotReviewingError(snap.change, snap.reviewing, snap.user));
        }
        return Promise.resolve({ kind: "marked", next: undefined, snapshot: snap, recorded: Promise.resolve() });
      },
    },
    (page) =>
      page.kind === "diff"
        ? {
            snapshot,
            viewed: { change: widgets, user: snapshot.user, base, files: new Map([[page.file, roundEnd]]) },
          }
        : {},
  );
  await app.open({ kind: "diff", change: widgets, file: api });
  await keys("!", "m");
  expect(screen()).toContain("does not include you. Mark anyway? y/n");
  await keys("y");
  expect(calls).toEqual([false, true]);
  // The round is done, so the diff page gives way to the review page.
  expect(screen()).toContain("/cabaret/review/widgets");
});

test("declining a question marks nothing and swallows the key", async () => {
  const calls: FilePath[] = [];
  const snapshot = reviewState([api]);
  const { app, keys, screen } = harness(
    {
      mark: (snap, file) => {
        calls.push(file);
        return Promise.resolve({ kind: "marked", next: undefined, snapshot: snap, recorded: Promise.resolve() });
      },
    },
    (page) => (page.kind === "review" ? { snapshot } : {}),
  );
  await app.open({ kind: "review", change: widgets });
  await keys("j", "!", "m");
  expect(screen()).toContain("Mark anyway? y/n");
  // q would close the page were it not answering the question.
  await keys("q");
  expect(calls).toEqual([]);
  expect(screen()).toContain("/cabaret/review/widgets");
});

test("a chained ask survives: never-displayed then not-reviewing, each answered y", async () => {
  const calls: boolean[] = [];
  const snapshot = { ...reviewState([api]), reviewing: "owner", asked: false } as const satisfies ChangeSnapshot;
  const { app, keys, screen } = harness(
    {
      mark: (snap, _file, evenThoughNotReviewing) => {
        calls.push(evenThoughNotReviewing);
        if (!evenThoughNotReviewing) {
          return Promise.reject(new NotReviewingError(snap.change, snap.reviewing, snap.user));
        }
        return Promise.resolve({ kind: "marked", next: undefined, snapshot: snap, recorded: Promise.resolve() });
      },
    },
    (page) => (page.kind === "diff" ? { snapshot } : {}),
  );
  await app.open({ kind: "diff", change: widgets, file: api });
  await keys("!", "m");
  expect(screen()).toContain("has not been displayed to you. Mark anyway? y/n");
  await keys("y");
  expect(screen()).toContain("does not include you. Mark anyway? y/n");
  await keys("y");
  expect(calls).toEqual([false, true]);
  expect(screen()).toContain("/cabaret/review/widgets");
});

test("^ climbs to the parent's show page", async () => {
  const { app, keys, screen } = harness({ parent: () => Promise.resolve(gadgets) });
  await app.open({ kind: "show", change: widgets });
  await keys("^");
  expect(screen()).toContain("/cabaret/show/gadgets");
});

test("$ with several children asks which; a digit picks", async () => {
  const { app, keys, screen } = harness({ children: () => Promise.resolve([gadgets, sprockets]) });
  await app.open({ kind: "show", change: widgets });
  await keys("$");
  expect(screen()).toContain("Child of widgets");
  expect(screen()).toContain("2  sprockets");
  await keys("2");
  expect(screen()).toContain("/cabaret/show/sprockets");
});

test("! r b rebases the cursor's change; a stale parent asks and retries with the override", async () => {
  const calls: object[] = [];
  const { app, keys, screen } = harness({
    rebase: (changes, overrides) => {
      calls.push({ changes, ...overrides });
      return overrides.parentDiverged
        ? Promise.resolve()
        : Promise.reject(new DivergedParentError(parseBranchName("main")));
    },
  });
  await app.open({ kind: "home" });
  await keys("j", "!", "r", "b");
  expect(screen()).toContain("has diverged from origin's copy. Rebase onto the local reading? y/n");
  await keys("y");
  expect(calls).toEqual([
    { changes: [widgets], notOwner: false, parentDiverged: false },
    { changes: [widgets], notOwner: false, parentDiverged: true },
  ]);
});

test("! r n renames through the minibuffer, editing the old name in place", async () => {
  const calls: object[] = [];
  const { app, keys, screen } = harness({
    rename: (from, to, evenThoughNotOwner) => {
      calls.push({ from, to, evenThoughNotOwner });
      return Promise.resolve();
    },
  });
  await app.open({ kind: "show", change: widgets });
  await keys("!", "r", "n");
  expect(screen()).toContain("Rename widgets: widgets");
  await keys("backspace", "2", "enter");
  expect(calls).toEqual([{ from: widgets, to: parseBranchName("widget2"), evenThoughNotOwner: false }]);
  // The show page follows the change to its new name.
  expect(screen()).toContain("/cabaret/show/widget2");
});

test("esc abandons a minibuffer input without acting", async () => {
  const calls: object[] = [];
  const { app, keys, screen } = harness({
    rename: (from, to) => {
      calls.push({ from, to });
      return Promise.resolve();
    },
  });
  await app.open({ kind: "show", change: widgets });
  await keys("!", "r", "n", "x", "esc", "enter");
  expect(calls).toEqual([]);
  expect(screen()).toContain("/cabaret/show/widgets");
});

test("! r p offers the other changes and reparents onto the pick", async () => {
  const calls: object[] = [];
  const { app, keys, screen } = harness({
    reparent: (change, parent, evenThoughNotOwner) => {
      calls.push({ change, parent, evenThoughNotOwner });
      return Promise.resolve();
    },
  });
  await app.open({ kind: "show", change: widgets });
  await keys("!", "r", "p");
  expect(screen()).toContain("New parent for widgets");
  expect(screen()).toContain("1  gadgets");
  await keys("2");
  expect(calls).toEqual([{ change: widgets, parent: sprockets, evenThoughNotOwner: false }]);
});

test("enter on a rebase action target runs the rebase", async () => {
  const calls: (readonly string[])[] = [];
  const actions: Doc = layout([
    {
      spans: [span("rebase", { target: { kind: "action", change: widgets, action: "rebase" } })],
    },
  ]);
  pages.set(pagePath({ kind: "home" }), actions);
  try {
    const { app, keys } = harness({
      rebase: (changes) => {
        calls.push(changes);
        return Promise.resolve();
      },
    });
    await app.open({ kind: "home" });
    await keys("enter");
    expect(calls).toEqual([[widgets]]);
  } finally {
    pages.set(pagePath({ kind: "home" }), home);
  }
});

test("landing past unsatisfied obligations asks once and reports the land", async () => {
  const calls: object[] = [];
  const { app, keys, screen } = harness({
    land: (changes, overrides) => {
      calls.push({ changes, ...overrides });
      return overrides.unreviewed ? Promise.resolve() : Promise.reject(new UnsatisfiedObligationsError([]));
    },
  });
  await app.open({ kind: "show", change: widgets });
  await keys("!", "l");
  expect(screen()).toContain("Review obligations are unsatisfied. Land anyway? y/n");
  await keys("y");
  expect(calls).toEqual([
    { changes: [widgets], notOwner: false, unreviewed: false, parentUnreviewed: false },
    { changes: [widgets], notOwner: false, unreviewed: true, parentUnreviewed: false },
  ]);
  expect(screen()).toContain("landed widgets");
});

test("$ and ^ step a diff page along its round; the ends report", async () => {
  const snapshot = reviewState([api, ui]);
  const { app, keys, screen } = harness({}, (page) => (page.kind === "diff" ? { snapshot } : {}));
  await app.open({ kind: "diff", change: widgets, file: api });
  await keys("^");
  expect(screen()).toContain("api.ts is the round's first file");
  await keys("$");
  expect(screen()).toContain("/cabaret/diff/widgets:ui.ts");
  await keys("^");
  expect(screen()).toContain("/cabaret/diff/widgets:api.ts");
});

test("esc steps outside: diff to review to show to home, then dissolves", async () => {
  const snapshot = reviewState([api]);
  const { app, keys, screen } = harness({}, (page) => (page.kind === "diff" ? { snapshot } : {}));
  await app.open({ kind: "diff", change: widgets, file: api });
  await keys("esc");
  expect(screen()).toContain("/cabaret/review/widgets");
  await keys("esc");
  expect(screen()).toContain("/cabaret/show/widgets");
  await keys("esc", "esc");
  expect(screen()).toContain("/cabaret/home");
  expect(screen()).not.toContain("undefined");
});

test("@ swaps the page to a typed identity and back to oneself", async () => {
  const { app, keys, screen } = harness();
  await app.open({ kind: "show", change: widgets });
  await keys("@");
  expect(screen()).toContain("Act as (currently alice@example.com)");
  // Option 2 is "someone else": type bob in.
  await keys("2");
  await keys("b", "o", "b", "enter");
  expect(screen()).toContain("/as/bob/cabaret/show/widgets");
  await keys("@", "1");
  expect(screen()).toContain("/cabaret/show/widgets");
  expect(screen()).not.toContain("/as/");
});

async function click(app: App, x: number, y: number): Promise<void> {
  await app.handleMouse({ kind: "press", x, y });
  await app.handleMouse({ kind: "release", x, y });
}

test("a click on a link follows it; a click on plain text just moves the cursor", async () => {
  const { app, screen } = harness();
  await app.open({ kind: "home" });
  // Row 2 is "\u251c\u2500 widgets": columns 0-2 are the tree guide, the link starts at column 3.
  // The gutter is 2 wide, so terminal column 6 (1-based) lands on the link's first character.
  await click(app, 6, 2);
  expect(screen()).toContain("/cabaret/show/widgets");
});

test("a click short of the link moves the cursor without following", async () => {
  const { app, screen } = harness();
  await app.open({ kind: "home" });
  await click(app, 3, 2);
  expect(screen()).toContain("/cabaret/home");
  expect(screen()).toMatchInlineSnapshot(`
    "  Changes
    ❯ ├─ widgets
      ├─ gadgets
      ╰─ cogs


     /cabaret/home                                                                                      "
  `);
});

test("a click past the content rows is ignored", async () => {
  const { app, frames, screen } = harness();
  await app.open({ kind: "home" });
  const before = frames.length;
  await app.handleMouse({ kind: "press", x: 1, y: 6 });
  expect(frames.length).toBe(before);
  expect(screen()).toContain("/cabaret/home");
});

test("the wheel scrolls the viewport and drags the cursor along", async () => {
  const tall: Doc = layout(Array.from({ length: 12 }, (_, i) => ({ spans: [span(`line ${i}`)] })));
  pages.set(pagePath({ kind: "home" }), tall);
  try {
    const { app, screen } = harness();
    await app.open({ kind: "home" });
    await app.handleMouse({ kind: "wheel", delta: 1 });
    expect(screen()).toMatchInlineSnapshot(`
      "❯ line 3
        line 4
        line 5
        line 6
        line 7
        line 8
       /cabaret/home                                                                                      "
    `);
    await app.handleMouse({ kind: "wheel", delta: -1 });
    expect(screen()).toContain("line 0");
  } finally {
    pages.set(pagePath({ kind: "home" }), home);
  }
});

test("a click while a question waits is not an answer", async () => {
  const calls: FilePath[] = [];
  const snapshot = reviewState([api]);
  const { app, keys, screen } = harness(
    {
      mark: (snap, file) => {
        calls.push(file);
        return Promise.resolve({ kind: "marked", next: undefined, snapshot: snap, recorded: Promise.resolve() });
      },
    },
    (page) => (page.kind === "review" ? { snapshot } : {}),
  );
  await app.open({ kind: "review", change: widgets });
  await keys("j", "!", "m");
  expect(screen()).toContain("Mark anyway? y/n");
  await click(app, 3, 1);
  expect(calls).toEqual([]);
  await keys("y");
  expect(calls).toEqual([api]);
});

test("V extends a selection the movement keys grow, and a stack rebases together", async () => {
  const calls: (readonly string[])[] = [];
  const { app, keys, screen } = harness({
    rebase: (changes) => {
      calls.push(changes);
      return Promise.resolve();
    },
  });
  await app.open({ kind: "home" });
  await keys("j", "V", "j");
  expect(screen()).toMatchInlineSnapshot(`
    "  Changes
    ▎ ├─ widgets
    ❯ ├─ gadgets
      ╰─ cogs


     /cabaret/home                                                                                      "
  `);
  await keys("!", "r", "b");
  expect(calls).toEqual([[widgets, gadgets]]);
  // The action consumed the selection.
  expect(screen()).not.toContain("\u258e");
});

test("dragging selects the rows crossed and lands them as a stack", async () => {
  const calls: (readonly string[])[] = [];
  const { app, keys, screen } = harness({
    land: (changes) => {
      calls.push(changes);
      return Promise.resolve();
    },
  });
  await app.open({ kind: "home" });
  await app.handleMouse({ kind: "press", x: 4, y: 2 });
  await app.handleMouse({ kind: "drag", x: 4, y: 3 });
  await app.handleMouse({ kind: "release", x: 4, y: 3 });
  expect(screen()).toContain("\u258e");
  await keys("!", "l");
  expect(calls).toEqual([[widgets, gadgets]]);
});

test("a single-change action over a selection asks for a single change", async () => {
  const calls: string[] = [];
  const { app, keys, screen } = harness({
    rename: (from) => {
      calls.push(from);
      return Promise.resolve();
    },
  });
  await app.open({ kind: "home" });
  await keys("j", "V", "j", "!", "r", "n");
  expect(calls).toEqual([]);
  expect(screen()).toContain("select a single change to rename");
});

test("esc drops a selection before anything else answers it", async () => {
  const { app, keys, screen } = harness();
  await app.open({ kind: "home" });
  await keys("j", "V", "j");
  expect(screen()).toContain("\u258e");
  await keys("esc");
  expect(screen()).not.toContain("\u258e");
  expect(screen()).toContain("/cabaret/home");
});

test("dragging back to the press row collapses the selection with it", async () => {
  const calls: (readonly string[])[] = [];
  const { app, keys } = harness({
    rebase: (changes) => {
      calls.push(changes);
      return Promise.resolve();
    },
  });
  await app.open({ kind: "home" });
  await app.handleMouse({ kind: "press", x: 4, y: 2 });
  await app.handleMouse({ kind: "drag", x: 4, y: 3 });
  await app.handleMouse({ kind: "drag", x: 4, y: 2 });
  await app.handleMouse({ kind: "release", x: 4, y: 2 });
  await keys("!", "r", "b");
  expect(calls).toEqual([[widgets]]);
});

test("a drag outside home spoils the click but hijacks nothing", async () => {
  const { app, keys, screen } = harness();
  await app.open({ kind: "show", change: widgets });
  await app.handleMouse({ kind: "press", x: 4, y: 2 });
  await app.handleMouse({ kind: "drag", x: 4, y: 3 });
  await app.handleMouse({ kind: "release", x: 4, y: 3 });
  expect(screen()).not.toContain("\u258e");
  // Esc still steps outside rather than clearing a phantom selection.
  await keys("esc");
  expect(screen()).toContain("/cabaret/home");
});

test("a key during a held press cancels the pending click", async () => {
  const { app, keys, screen } = harness();
  await app.open({ kind: "home" });
  await app.handleMouse({ kind: "press", x: 6, y: 2 });
  await keys("j");
  await app.handleMouse({ kind: "release", x: 6, y: 2 });
  expect(screen()).toContain("/cabaret/home");
  expect(screen()).not.toContain("/cabaret/show/widgets");
});

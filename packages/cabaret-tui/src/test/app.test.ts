import {
  DirtyParentError,
  DivergedParentError,
  type FilePath,
  type FileView,
  NotOwnerError,
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
const tip = parseCommitHash("3".repeat(40));

function fileView(): FileView {
  return { kind: "fresh", source: undefined, modes: undefined };
}

/** A snapshot with review pending over `files`, reviewed by alice. */
function reviewState(files: readonly FilePath[]): ChangeSnapshot {
  return {
    change: widgets,
    user: userName("alice@example.com"),
    as: undefined,
    reviewing: "everyone",
    asked: true,
    base,
    tip,
    conflicts: [],
    changed: files.map((file) => ({ path: file, source: undefined, modes: undefined })),
    left: new Map(files.map((file) => [file, fileView()])),
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
    { spans: [span("api.ts", { target: { kind: "file", page: "review", change: widgets, file: api } })] },
  ]),
]);

const reviewList: Doc = layout([
  { spans: [span("Review widgets", { style: "heading" })] },
  { spans: [span("api.ts", { target: { kind: "file", page: "review", change: widgets, file: api } })] },
  { spans: [span("ui.ts", { target: { kind: "file", page: "review", change: widgets, file: ui } })] },
]);

const diffList: Doc = layout([
  { spans: [span("Diff widgets", { style: "heading" })] },
  { spans: [span("api.ts", { target: { kind: "file", page: "diff", change: widgets, file: api } })] },
  { spans: [span("ui.ts", { target: { kind: "file", page: "diff", change: widgets, file: ui } })] },
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
  [pagePath({ kind: "reviews", change: widgets }), reviewList],
  [
    pagePath({ kind: "review", change: widgets, file: api }),
    layout([{ spans: [span("const a = 1;", { style: "removed" })] }]),
  ],
  [
    pagePath({ kind: "review", change: widgets, file: ui }),
    layout([{ spans: [span("const b = 2;", { style: "added" })] }]),
  ],
  [pagePath({ kind: "diffs", change: widgets }), diffList],
  [
    pagePath({ kind: "diff", change: widgets, file: api }),
    layout([{ spans: [span("const a = 0;", { style: "removed" })] }]),
  ],
  [
    pagePath({ kind: "diff", change: widgets, file: ui }),
    layout([{ spans: [span("const b = 0;", { style: "removed" })] }]),
  ],
]);

interface Harness {
  readonly app: App;
  readonly frames: string[][];
  readonly cursors: { row: number; column: number }[];
  /** The last frame with SGR escapes stripped. */
  readonly screen: () => string;
  readonly keys: (...keys: readonly string[]) => Promise<readonly ("continue" | "quit")[]>;
}

function harness(overrides?: Partial<Effects>, rendered?: (page: Page) => Partial<Rendered>): Harness {
  const frames: string[][] = [];
  const cursors: { row: number; column: number }[] = [];
  const terminal: Terminal = {
    columns: () => 100,
    rows: () => 7,
    depth: "ansi256",
    render: (rows, cursor) => {
      frames.push([...rows]);
      cursors.push(cursor);
    },
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
    reparent: unavailable("reparenting"),
    setOwner: unavailable("owner transfer"),
    widenReviewing: unavailable("widening"),
    disableReviewing: unavailable("reviewing"),
    toggleArchived: unavailable("archiving"),
    gotoWorkspace: unavailable("workspaces"),
    addWorkspace: unavailable("workspaces"),
    removeWorkspace: unavailable("workspaces"),
    reclaimWorkspaces: unavailable("workspaces"),
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
    cursors,
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
    "Changes
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
    "widgets
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
    "widgets
    Files to review …




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
  // The home page is still the one open: the report passes with the next key.
  expect(screen()).toContain("Changes");
  await keys("k");
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
  expect(screen()).toContain("/cabaret/review/widgets:api.ts");
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
      page.kind === "review"
        ? {
            snapshot,
            viewed: { change: widgets, user: snapshot.user, base, files: new Map([[page.file, tip]]) },
          }
        : {},
  );
  await app.open({ kind: "review", change: widgets, file: api });
  await keys("!", "m");
  expect(calls).toEqual([[api, false]]);
  expect(screen()).toContain("/cabaret/review/widgets:ui.ts");
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
    (page) => (page.kind === "review" || page.kind === "reviews" ? { snapshot } : {}),
  );
  await app.open({ kind: "reviews", change: widgets });
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
      page.kind === "review"
        ? {
            snapshot,
            viewed: { change: widgets, user: snapshot.user, base, files: new Map([[page.file, tip]]) },
          }
        : {},
  );
  await app.open({ kind: "review", change: widgets, file: api });
  await keys("!", "m");
  expect(screen()).toContain("does not include you. Mark anyway? y/n");
  await keys("y");
  expect(calls).toEqual([false, true]);
  // The round is done, so the diff page gives way to the review page.
  expect(screen()).toContain("/cabaret/reviews/widgets");
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
    (page) => (page.kind === "review" || page.kind === "reviews" ? { snapshot } : {}),
  );
  await app.open({ kind: "reviews", change: widgets });
  await keys("j", "!", "m");
  expect(screen()).toContain("Mark anyway? y/n");
  // q would close the page were it not answering the question.
  await keys("q");
  expect(calls).toEqual([]);
  expect(screen()).toContain("/cabaret/reviews/widgets");
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
    (page) => (page.kind === "review" || page.kind === "reviews" ? { snapshot } : {}),
  );
  await app.open({ kind: "review", change: widgets, file: api });
  await keys("!", "m");
  expect(screen()).toContain("has not been displayed to you. Mark anyway? y/n");
  await keys("y");
  expect(screen()).toContain("does not include you. Mark anyway? y/n");
  await keys("y");
  expect(calls).toEqual([false, true]);
  expect(screen()).toContain("/cabaret/reviews/widgets");
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
        ? Promise.resolve(undefined)
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

test("! c against a dirty parent offers carrying the edits or leaving them", async () => {
  const calls: object[] = [];
  const { app, keys, screen } = harness({
    create: (change, parent, remedy) => {
      calls.push({ change, parent, remedy });
      return remedy === undefined ? Promise.reject(new DirtyParentError(widgets, "/repo", true)) : Promise.resolve();
    },
  });
  await app.open({ kind: "show", change: widgets });
  await keys("!", "c", "d", "o", "o", "d", "a", "d", "enter");
  expect(screen()).toContain("Parent widgets has uncommitted changes");
  expect(screen()).toContain("1  carry them into doodad");
  expect(screen()).toContain("2  leave them on widgets");
  await keys("1");
  expect(calls).toEqual([
    { change: parseBranchName("doodad"), parent: widgets, remedy: undefined },
    { change: parseBranchName("doodad"), parent: widgets, remedy: "carry" },
  ]);
});

test("! c against a parent dirty in another workspace asks before leaving the edits", async () => {
  const calls: object[] = [];
  const { app, keys, screen } = harness({
    create: (change, parent, remedy) => {
      calls.push({ change, parent, remedy });
      return remedy === undefined
        ? Promise.reject(new DirtyParentError(widgets, "/elsewhere", false))
        : Promise.resolve();
    },
  });
  await app.open({ kind: "show", change: widgets });
  await keys("!", "c", "d", "o", "o", "d", "a", "d", "enter");
  expect(screen()).toContain("Parent widgets has uncommitted changes at /elsewhere. Create anyway, leaving them? y/n");
  await keys("y");
  expect(calls).toEqual([
    { change: parseBranchName("doodad"), parent: widgets, remedy: undefined },
    { change: parseBranchName("doodad"), parent: widgets, remedy: "leave" },
  ]);
});

test("esc abandons a minibuffer input without acting", async () => {
  const calls: object[] = [];
  const { app, keys, screen } = harness({
    create: (change, parent) => {
      calls.push({ change, parent });
      return Promise.resolve(undefined);
    },
  });
  await app.open({ kind: "show", change: widgets });
  await keys("!", "c", "x", "esc", "enter");
  expect(calls).toEqual([]);
  expect(screen()).toContain("/cabaret/show/widgets");
});

test("! r p offers the other changes and reparents onto the pick", async () => {
  const calls: object[] = [];
  const { app, keys, screen } = harness({
    reparent: (change, parent, evenThoughNotOwner) => {
      calls.push({ change, parent, evenThoughNotOwner });
      return Promise.resolve(undefined);
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
        return Promise.resolve(undefined);
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

test("$ and ^ step a diff page along the files left; the ends report", async () => {
  const snapshot = reviewState([api, ui]);
  const { app, keys, screen } = harness({}, (page) => (page.kind === "review" ? { snapshot } : {}));
  await app.open({ kind: "review", change: widgets, file: api });
  await keys("^");
  expect(screen()).toContain("api.ts is the first file left");
  await keys("$");
  expect(screen()).toContain("/cabaret/review/widgets:ui.ts");
  await keys("^");
  expect(screen()).toContain("/cabaret/review/widgets:api.ts");
});

test("esc steps outside: review to reviews to show to home, then dissolves", async () => {
  const snapshot = reviewState([api]);
  const { app, keys, screen } = harness({}, (page) => (page.kind === "review" ? { snapshot } : {}));
  await app.open({ kind: "review", change: widgets, file: api });
  await keys("esc");
  expect(screen()).toContain("/cabaret/reviews/widgets");
  await keys("esc");
  expect(screen()).toContain("/cabaret/show/widgets");
  await keys("esc", "esc");
  expect(screen()).toContain("/cabaret/home");
  expect(screen()).not.toContain("undefined");
});

test("r and d enter a family from show, and swap the lists in place", async () => {
  const { app, keys, screen } = harness();
  await app.open({ kind: "show", change: widgets });
  await keys("d");
  expect(screen()).toContain("/cabaret/diffs/widgets");
  await keys("r");
  expect(screen()).toContain("/cabaret/reviews/widgets");
  // The swap replaced the diffs page, so stepping outside lands on show.
  await keys("esc");
  expect(screen()).toContain("/cabaret/show/widgets");
});

test("r and d swap a file's review and diff pages, keeping the file", async () => {
  const { app, keys, screen } = harness();
  await app.open({ kind: "diff", change: widgets, file: api });
  await keys("r");
  expect(screen()).toContain("/cabaret/review/widgets:api.ts");
  await keys("d");
  expect(screen()).toContain("/cabaret/diff/widgets:api.ts");
  // Each swap replaced the page it left, so esc walks out through the
  // current family's list alone.
  await keys("esc");
  expect(screen()).toContain("/cabaret/diffs/widgets");
});

test("r on a home row opens that change's reviews; a row with no change reports", async () => {
  const { app, keys, screen } = harness();
  await app.open({ kind: "home" });
  await keys("r");
  expect(screen()).toContain("no change at the cursor");
  await keys("j", "d");
  expect(screen()).toContain("/cabaret/diffs/widgets");
  // Popping back leaves the cursor on the same row, so r reads it too.
  await keys("q", "r");
  expect(screen()).toContain("/cabaret/reviews/widgets");
});

test("$ and ^ step a diff page along every changed file, not just review left", async () => {
  const snapshot = {
    ...reviewState([ui]),
    changed: [api, ui].map((f) => ({ path: f, source: undefined, modes: undefined })),
  };
  const { app, keys, screen } = harness({}, (page) => (page.kind === "diff" ? { snapshot } : {}));
  await app.open({ kind: "diff", change: widgets, file: api });
  await keys("^");
  expect(screen()).toContain("api.ts is the first file changed");
  await keys("$");
  expect(screen()).toContain("/cabaret/diff/widgets:ui.ts");
  await keys("$");
  expect(screen()).toContain("ui.ts is the last file changed");
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
  // With no gutter, terminal column 6 (1-based) lands inside the link.
  await click(app, 6, 2);
  expect(screen()).toContain("/cabaret/show/widgets");
});

test("a click short of the link moves the cursor without following", async () => {
  const { app, screen } = harness();
  await app.open({ kind: "home" });
  await click(app, 3, 2);
  expect(screen()).toContain("/cabaret/home");
  expect(screen()).toMatchInlineSnapshot(`
    "Changes
    ├─ widgets
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
      "line 3
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
    (page) => (page.kind === "review" || page.kind === "reviews" ? { snapshot } : {}),
  );
  await app.open({ kind: "reviews", change: widgets });
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
      return Promise.resolve(undefined);
    },
  });
  await app.open({ kind: "home" });
  await keys("j", "V", "j");
  expect(screen()).toMatchInlineSnapshot(`
    "Changes
    ├─ widgets                                                                                          
    ├─ gadgets                                                                                          
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
  const { app, keys, frames } = harness({
    land: (changes) => {
      calls.push(changes);
      return Promise.resolve(undefined);
    },
  });
  await app.open({ kind: "home" });
  await app.handleMouse({ kind: "press", x: 4, y: 2 });
  await app.handleMouse({ kind: "drag", x: 4, y: 3 });
  await app.handleMouse({ kind: "release", x: 4, y: 3 });
  // The selection wash paints the dragged rows.
  expect(frames[frames.length - 1]?.join("\n")).toContain("48;5;238");
  await keys("!", "l");
  expect(calls).toEqual([[widgets, gadgets]]);
});

test("a single-change action over a selection asks for a single change", async () => {
  const calls: string[] = [];
  const { app, keys, screen } = harness({
    create: (change) => {
      calls.push(change);
      return Promise.resolve(undefined);
    },
  });
  await app.open({ kind: "home" });
  await keys("j", "V", "j", "!", "c");
  expect(calls).toEqual([]);
  expect(screen()).toContain("select a single change to create a child of");
});

test("! a toggles each selected change and reports both directions", async () => {
  const calls: string[] = [];
  const { app, keys, screen } = harness({
    toggleArchived: (change) => {
      calls.push(change);
      return Promise.resolve(change === widgets);
    },
  });
  await app.open({ kind: "home" });
  await keys("j", "V", "j", "!", "a");
  expect(calls).toEqual([widgets, gadgets]);
  expect(screen()).toContain("widgets archived; gadgets unarchived");
});

test("! o sets one owner across a selection; a retry past ownership skips the applied", async () => {
  const calls: object[] = [];
  const { app, keys, screen } = harness({
    setOwner: (change, owner, evenThoughNotOwner) => {
      calls.push({ change, owner, evenThoughNotOwner });
      return change === gadgets && !evenThoughNotOwner
        ? Promise.reject(new NotOwnerError(gadgets, userName("bob@example.com"), userName("alice@example.com")))
        : Promise.resolve();
    },
  });
  await app.open({ kind: "home" });
  await keys("j", "V", "j", "!", "o");
  expect(screen()).toContain("New owner for widgets, gadgets");
  await keys("b", "o", "b", "enter");
  expect(screen()).toContain("gadgets is owned by bob@example.com, not you. Set owner anyway? y/n");
  await keys("y");
  expect(calls).toEqual([
    { change: widgets, owner: "bob", evenThoughNotOwner: false },
    { change: gadgets, owner: "bob", evenThoughNotOwner: false },
    { change: gadgets, owner: "bob", evenThoughNotOwner: true },
  ]);
});

test("esc drops a selection before anything else answers it", async () => {
  const { app, keys, frames } = harness();
  await app.open({ kind: "home" });
  await keys("j", "V", "j");
  expect(frames[frames.length - 1]?.join("\n")).toContain("48;5;238");
  await keys("esc");
  expect(frames[frames.length - 1]?.join("\n")).not.toContain("48;5;238");
});

test("dragging back to the press row collapses the selection with it", async () => {
  const calls: (readonly string[])[] = [];
  const { app, keys } = harness({
    rebase: (changes) => {
      calls.push(changes);
      return Promise.resolve(undefined);
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

test("the terminal cursor tracks the goal column across lines and h/l moves it", async () => {
  const { app, keys, cursors } = harness();
  await app.open({ kind: "home" });
  expect(cursors[cursors.length - 1]).toEqual({ row: 0, column: 0 });
  await keys("l", "l", "l");
  expect(cursors[cursors.length - 1]).toEqual({ row: 0, column: 3 });
  // "Changes" is 7 wide; the rows below vary, and the aim survives the trip.
  await keys("G");
  expect(cursors[cursors.length - 1]?.row).toBe(3);
  await keys("h");
  expect(cursors[cursors.length - 1]?.column).toBeLessThanOrEqual(7);
});

test("a click lands the cursor cell where it fell", async () => {
  const { app, cursors } = harness();
  await app.open({ kind: "home" });
  await click(app, 6, 2);
  // The click opened the show page; its fresh view starts at the origin.
  expect(cursors[cursors.length - 1]).toEqual({ row: 0, column: 0 });
});

test("the minibuffer parks the cursor after the typed text on the status row", async () => {
  const { app, keys, cursors } = harness();
  await app.open({ kind: "show", change: widgets });
  await keys("!", "c");
  // " Name for a child of widgets: " is 30 code points; the cursor sits after it.
  expect(cursors[cursors.length - 1]).toEqual({ row: 6, column: 30 });
});

test("v selects as V does while every selection is line-wise", async () => {
  const calls: (readonly string[])[] = [];
  const { app, keys } = harness({
    rebase: (changes) => {
      calls.push(changes);
      return Promise.resolve(undefined);
    },
  });
  await app.open({ kind: "home" });
  await keys("j", "v", "j", "!", "r", "b");
  expect(calls).toEqual([[widgets, gadgets]]);
});

test("! w r reclaims workspaces from home and nowhere else", async () => {
  const { app, keys, screen } = harness({
    reclaimWorkspaces: () => Promise.resolve("removed 2 workspaces"),
  });
  await app.open({ kind: "home" });
  await keys("!", "w", "r");
  expect(screen()).toContain("removed 2 workspaces");
  // On a show page the chord is no binding at all.
  await app.open({ kind: "show", change: widgets });
  await keys("!", "w", "r");
  expect(screen()).toContain("! w r is undefined");
});

test("a rebase whose merge leaves markers reports as a note, not an error", async () => {
  const { app, keys, screen } = harness({
    rebase: () => Promise.resolve("merged main into widgets with conflicts in a.ts; fix the markers and commit"),
  });
  await app.open({ kind: "home" });
  await keys("j", "!", "r", "b");
  expect(screen()).toContain("merged main into widgets with conflicts in a.ts; fix the markers and commit");
});

import { parseBranchName, parseFilePath } from "cabaret-core";
import { type Doc, layout, type Page, pagePath, section, span } from "cabaret-views";
import { expect, test } from "vitest";
import { App, type Effects, type Terminal } from "../app.js";

const widgets = parseBranchName("widgets");
const gadgets = parseBranchName("gadgets");
const api = parseFilePath("api.ts");

const home: Doc = layout([
  { spans: [span("Changes", { style: "heading" })] },
  { spans: [span("├─ "), span("widgets", { target: { kind: "change", change: widgets } })] },
  { spans: [span("╰─ "), span("gadgets", { target: { kind: "change", change: gadgets } })] },
]);

const show: Doc = layout([
  { spans: [span("widgets", { style: "heading" })] },
  section({ spans: [span("Files to review")] }, [
    { spans: [span("api.ts", { target: { kind: "file", change: widgets, file: api } })] },
  ]),
]);

const pages = new Map<string, Doc>([
  [pagePath({ kind: "home" }), home],
  [pagePath({ kind: "show", change: widgets }), show],
]);

interface Harness {
  readonly app: App;
  readonly frames: string[][];
  /** The last frame with SGR escapes stripped, cursor gutter and all. */
  readonly screen: () => string;
  readonly keys: (...keys: readonly string[]) => Promise<readonly ("continue" | "quit")[]>;
}

function harness(overrides?: Partial<Effects>): Harness {
  const frames: string[][] = [];
  const terminal: Terminal = {
    columns: () => 60,
    rows: () => 7,
    depth: "ansi256",
    render: (rows) => frames.push([...rows]),
  };
  const effects: Effects = {
    visitLocation: () => Promise.resolve("visited"),
    openUrl: () => Promise.resolve(undefined),
    ...overrides,
  };
  const source = (page: Page): Promise<Doc> => {
    const doc = pages.get(pagePath(page));
    return doc === undefined ? Promise.reject(new Error(`no page at ${pagePath(page)}`)) : Promise.resolve(doc);
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
      ╰─ gadgets



     /cabaret/home                                              "
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



     /cabaret/show/widgets                                      "
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




     /cabaret/show/widgets                                      "
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
  await keys("j", "j", "enter");
  expect(screen()).toContain("no page at /cabaret/show/gadgets");
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
  // The fake source lacks the diff page; the report naming the diff path
  // proves the file target routed there.
  expect(screen()).toContain("no page at /cabaret/diff/widgets:api.ts");
});

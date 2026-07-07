import {
  type Backend,
  type CommitHash,
  type LogEntry,
  parseCommitHash,
  parseFilePath,
  parseRefName,
  timestampMs,
  userName,
} from "cabaret-core";
import { expect, test } from "vitest";
import {
  type ChangeSnapshot,
  type DiffPage,
  diffDoc,
  docText,
  markReviewed,
  reviewDoc,
  reviewPage,
  targetAt,
} from "../index.js";

function fake(digit: string): CommitHash {
  return parseCommitHash(digit.repeat(40));
}

const widgets = parseRefName("widgets");

test("reviewDoc lists the round's files and what follows", () => {
  const doc = reviewDoc({
    change: widgets,
    round: { end: fake("3"), files: [parseFilePath("api.ts"), parseFilePath("ui.ts")], later: 2 },
  });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "Review widgets
    ==============

    Reviewing up to 333333333333; 2 more rounds follow.

      api.ts
      ui.ts"
  `);
  const line = docText(doc)
    .split("\n")
    .findIndex((text) => text.includes("api.ts"));
  expect(targetAt(doc, line)).toEqual({ kind: "file", change: "widgets", file: "api.ts" });
  expect(targetAt(doc, 0)).toEqual({ kind: "change", change: "widgets" });
});

test("reviewDoc of the last round drops the indicator", () => {
  const doc = reviewDoc({ change: widgets, round: { end: fake("3"), files: [parseFilePath("api.ts")], later: 0 } });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "Review widgets
    ==============

    Reviewing up to 333333333333.

      api.ts"
  `);
});

test("reviewDoc with nothing left says so", () => {
  expect(docText(reviewDoc({ change: widgets, round: undefined }))).toMatchInlineSnapshot(`
    "Review widgets
    ==============

    Nothing left to review."
  `);
});

function diffPageWith(round: DiffPage["round"]): DiffPage {
  return { change: widgets, file: parseFilePath("api.ts"), round };
}

test("diffDoc renders a two-way diff bare of marks, styling its added and removed lines", () => {
  const doc = diffDoc(
    diffPageWith({ end: fake("3"), later: 1, view: { kind: "two", prev: "shared\ngone\n", next: "shared\nhere\n" } }),
  );
  expect(docText(doc)).toMatchInlineSnapshot(`
    "api.ts in widgets (up to 333333333333; 1 more round follows)

    -1,2 +1,2
    shared
    gone
    here"
  `);
  const styles = doc.lines.map(({ spans }) => spans.map(({ text, style }) => [text, style]));
  expect(styles.filter((line) => line.some(([, style]) => style !== undefined))).toEqual([
    [["api.ts in widgets (up to 333333333333; 1 more round follows)", "heading"]],
    [["-1,2 +1,2", "hunk"]],
    [["gone", "removed"]],
    [["here", "added"]],
  ]);
});

test("diffDoc anchors each hunk line to its place in the new copy, on the jump tier", () => {
  const doc = diffDoc(
    diffPageWith({ end: fake("3"), later: 0, view: { kind: "two", prev: "shared\ngone\n", next: "shared\nhere\n" } }),
  );
  const location = (line: number) => ({ kind: "location", file: "api.ts", line });
  expect(doc.lines.map((_, i) => targetAt(doc, i))).toEqual([
    { kind: "change", change: "widgets" },
    undefined, // blank
    location(1), // -1,2 +1,2
    location(1), // shared
    location(2), // gone: the removal site, where "here" now sits
    location(2), // here
  ]);
  // Only the heading advertises itself as a link; hunk lines answer the cursor alone.
  expect(doc.lines.map(({ spans }) => spans[0]?.tier)).toEqual(["link", undefined, "jump", "jump", "jump", "jump"]);
});

test("diffDoc trims each hunk to the requested context", () => {
  const lines = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  const prev = `${lines.join("\n")}\n`;
  const next = `${lines.join("\n").replace("two", "TWO").replace("eight", "EIGHT")}\n`;
  const doc = diffDoc(diffPageWith({ end: fake("3"), later: 0, view: { kind: "two", prev, next } }), 1);
  expect(docText(doc)).toMatchInlineSnapshot(`
    "api.ts in widgets (up to 333333333333)

    -1,3 +1,3
    one
    two
    TWO
    three

    -7,3 +7,3
    seven
    eight
    EIGHT
    nine"
  `);
});

test("diffDoc shows the whole file in one hunk at context -1", () => {
  const lines = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  const prev = `${lines.join("\n")}\n`;
  const next = `${lines.join("\n").replace("two", "TWO").replace("eight", "EIGHT")}\n`;
  const doc = diffDoc(diffPageWith({ end: fake("3"), later: 0, view: { kind: "two", prev, next } }), -1);
  expect(docText(doc)).toMatchInlineSnapshot(`
    "api.ts in widgets (up to 333333333333)

    -1,9 +1,9
    one
    two
    TWO
    three
    four
    five
    six
    seven
    eight
    EIGHT
    nine"
  `);
});

test("diffDoc shows a four-way diff whole at context -1", () => {
  const middle = ["two", "three", "four", "five", "six", "seven", "eight"].join("\n");
  const page = diffPageWith({
    end: fake("4"),
    later: 0,
    view: {
      kind: "four",
      revs: { b1: fake("1"), b2: fake("2"), f1: fake("3"), f2: fake("4") },
      contents: {
        b1: `one\n${middle}\nnine\n`,
        b2: `ONE\n${middle}\nnine\n`,
        f1: `one\n${middle}\nnine\nchild\n`,
        f2: `ONE!\n${middle}\nnine\nchild\n`,
      },
    },
  });
  // "five" sits mid-file, farther from both changes than the trimmed context.
  expect(docText(diffDoc(page, 1))).not.toContain("five");
  expect(docText(diffDoc(page, -1))).toContain("five");
});

test("diffDoc styles an added blank line, so hosts wash it like its neighbors", () => {
  const doc = diffDoc(
    diffPageWith({ end: fake("3"), later: 0, view: { kind: "two", prev: "one\ntwo\n", next: "one\n\nnew\ntwo\n" } }),
  );
  const styles = doc.lines.map(({ spans }) => spans.map(({ text, style }) => [text, style]));
  expect(styles.filter((line) => line.some(([, style]) => style === "added"))).toEqual([
    [["", "added"]],
    [["new", "added"]],
  ]);
});

test("diffDoc anchors a mid-file hunk from its header, not from 1", () => {
  // Long enough that patdiff trims leading context and the hunk starts deep.
  const prev = `${Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
  const doc = diffDoc(diffPageWith({ end: fake("3"), later: 0, view: { kind: "two", prev, next: `${prev}tail\n` } }));
  const added = doc.lines.findIndex(({ spans }) =>
    spans.some(({ text, style }) => text === "tail" && style === "added"),
  );
  expect(targetAt(doc, added)).toEqual({ kind: "location", file: "api.ts", line: 41 });
});

test("diffDoc keeps a long modified line whole instead of splitting it", () => {
  const long = (word: string) => `const banner = "${word}: ${"x".repeat(90)}";\n`;
  const doc = diffDoc(
    diffPageWith({ end: fake("3"), later: 0, view: { kind: "two", prev: long("before"), next: long("after") } }),
  );
  const hunk = doc.lines.slice(3).map(({ spans }) => spans.map(({ text, style }) => [text, style]));
  expect(hunk).toEqual([[[long("before").slice(0, -1), "removed"]], [[long("after").slice(0, -1), "added"]]]);
  expect(targetAt(doc, 4)).toEqual({ kind: "location", file: "api.ts", line: 1 });
});

test("diffDoc leaves a context line unstyled even when its text starts like a mark", () => {
  const doc = diffDoc(
    diffPageWith({ end: fake("3"), later: 0, view: { kind: "two", prev: "-|weird\n", next: "-|weird\nnew\n" } }),
  );
  const hunk = doc.lines.slice(2).map(({ spans }) => spans.map(({ text, style }) => [text, style]));
  expect(hunk).toEqual([[["-1,1 +1,2", "hunk"]], [["-|weird", undefined]], [["new", "added"]]]);
});

test("diffDoc omits the redundant file-name lines for a newly added file", () => {
  const doc = diffDoc(
    diffPageWith({ end: fake("3"), later: 0, view: { kind: "two", prev: undefined, next: "new\n" } }),
  );
  expect(docText(doc)).toMatchInlineSnapshot(`
    "api.ts in widgets (up to 333333333333)

    -1,0 +1,1
    new"
  `);
});

test("diffDoc renders a four-way diff when the base changed under the review", () => {
  const doc = diffDoc(
    diffPageWith({
      end: fake("4"),
      later: 0,
      view: {
        kind: "four",
        revs: { b1: fake("1"), b2: fake("2"), f1: fake("3"), f2: fake("4") },
        contents: { b1: "one\n", b2: "ONE\n", f1: "one\nchild\n", f2: "ONE!\nchild\n" },
      },
    }),
  );
  expect(docText(doc)).toMatchInlineSnapshot(`
    "api.ts in widgets (up to 444444444444)

    @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ api.ts @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
    old base 111111111111 | old tip 333333333333 | new base 222222222222 | new tip 444444444444
    _
    | @@@@@@@@ View 1/8 : feature-ddiff @@@@@@@@
    | @@@@@@@@ -- old base 1,3 old tip 1,4 @@@@@@@@
    | @@@@@@@@ ++ new base 1,3 new tip 1,4 @@@@@@@@
    | --  one
    | ++-|ONE
    | +++|ONE!
    |   +|child
    |_
    _
    | @@@@@@@@ View 2/8 : base-ddiff @@@@@@@@
    | @@@@@@@@ -- old base 1,3 new base 1,4 @@@@@@@@
    | @@@@@@@@ ++ old tip 1,3 new tip 1,4 @@@@@@@@
    |   -|one
    | --+|ONE
    | +++|ONE!
    | ++  child
    |_
    _
    | @@@@@@@@ View 3/8 : old-tip-to-new-tip @@@@@@@@
    | @@@@@@@@ old tip 1,3 new tip 1,3 @@@@@@@@
    | -|one
    | +|ONE!
    |   child
    |_
    _
    | @@@@@@@@ View 4/8 : new-base-to-new-tip @@@@@@@@
    | @@@@@@@@ new base 1,2 new tip 1,3 @@@@@@@@
    | -|ONE
    | +|ONE!
    | +|child
    |_
    _
    | @@@@@@@@ View 5/8 : old-base-to-old-tip @@@@@@@@
    | @@@@@@@@ old base 1,2 old tip 1,3 @@@@@@@@
    |   one
    | +|child
    |_
    _
    | @@@@@@@@ View 6/8 : old-base-to-new-base @@@@@@@@
    | @@@@@@@@ old base 1,2 new base 1,2 @@@@@@@@
    | -|one
    | +|ONE
    |_
    _
    | @@@@@@@@ View 7/8 : old-base-to-new-tip @@@@@@@@
    | @@@@@@@@ old base 1,2 new tip 1,3 @@@@@@@@
    | -|one
    | +|ONE!
    | +|child
    |_
    _
    | @@@@@@@@ View 8/8 : conflict-resolution @@@@@@@@
    | @@@@@@@@ conflict 1,9 new tip 1,3 @@@@@@@@
    | -|<<<<<<< old tip
    | -|one
    | +|ONE!
    |   child
    | -|||||||| old base
    | -|one
    | -|=======
    | -|ONE
    | -|>>>>>>> new base
    |_"
  `);
  // Lines anchor to their home in the new tip where they have one: added and
  // context lines directly, removed lines at the site their replacement now
  // holds, and lines of views that never touch the new tip not at all.
  const location = (line: number) => ({ kind: "location", file: "api.ts", line });
  const rendered = docText(doc).split("\n");
  const targetOf = (text: string) => targetAt(doc, rendered.indexOf(text));
  expect(targetOf("| @@@@@@@@ new base 1,2 new tip 1,3 @@@@@@@@")).toEqual(location(1));
  expect(targetOf("| -|ONE")).toEqual(location(1)); // the removal site in the new tip
  expect(targetOf("| +|ONE!")).toEqual(location(1));
  expect(targetOf("| +|child")).toEqual(location(2));
  expect(targetOf("| +++|ONE!")).toEqual(location(1)); // ddiff lines know their inner homes
  expect(targetOf("|   +|child")).toEqual(location(2));
  expect(targetOf("| ++-|ONE")).toBeUndefined(); // removed before its view's first anchor
  expect(targetOf("|   one")).toBeUndefined(); // old-base-to-old-tip: no new-tip content
  expect(targetOf("| +|ONE")).toBeUndefined(); // old-base-to-new-base: no new-tip content
  expect(targetOf("| -|<<<<<<< old tip")).toBeUndefined(); // conflict text lives in no file
  // The stacked signs still read through to added/removed styling.
  const styleOf = (text: string) => doc.lines[rendered.indexOf(text)]?.spans[0]?.style;
  expect(styleOf("| ++-|ONE")).toBe("removed");
  expect(styleOf("|   +|child")).toBe("added");
  expect(styleOf("| --  one")).toBeUndefined();
  // Anchored lines sit on the jump tier, never advertised as links.
  const tierOf = (text: string) => doc.lines[rendered.indexOf(text)]?.spans[0]?.tier;
  expect(tierOf("| +|ONE!")).toBe("jump");
  expect(tierOf("|   one")).toBeUndefined();
});

test("diffDoc with an empty diff points at marking the file reviewed", () => {
  const doc = diffDoc(
    diffPageWith({ end: fake("3"), later: 0, view: { kind: "two", prev: "same\n", next: "same\n" } }),
  );
  expect(docText(doc)).toMatchInlineSnapshot(`
    "api.ts in widgets (up to 333333333333)

    No differences left to read; mark the file reviewed to record that."
  `);
});

test("diffDoc reports binary versions instead of diffing them", () => {
  const doc = diffDoc(
    diffPageWith({ end: fake("3"), later: 0, view: { kind: "two", prev: "a\0b\n", next: "c\0d\n" } }),
  );
  expect(docText(doc)).toMatchInlineSnapshot(`
    "api.ts in widgets (up to 333333333333)

    Binary versions of api.ts differ"
  `);
});

test("diffDoc side by side pairs the panes around a divider, styling changed words", () => {
  const doc = diffDoc(
    diffPageWith({
      end: fake("3"),
      later: 0,
      view: { kind: "two", prev: "intro\ncount = one\noutro\n", next: "intro\ncount = two\noutro\n" },
    }),
    undefined,
    "wrap",
  );
  expect(docText(doc)).toMatchInlineSnapshot(`
    "api.ts in widgets (up to 333333333333)

    1 intro                                                       │ 1 intro
    2 count = one                                                 │ 2 count = two
    3 outro                                                       │ 3 outro"
  `);
  const styles = doc.lines.map(({ spans }) => spans.flatMap(({ text, style }) => (style ? [[text, style]] : [])));
  expect(styles.filter((line) => line.length > 0)).toMatchInlineSnapshot(`
    [
      [
        [
          "api.ts in widgets (up to 333333333333)",
          "heading",
        ],
      ],
      [
        [
          " one",
          "removed",
        ],
        [
          " two",
          "added",
        ],
      ],
    ]
  `);
  const location = (line: number) => ({ kind: "location", file: "api.ts", line });
  expect(doc.lines.map((_, i) => targetAt(doc, i))).toEqual([
    { kind: "change", change: "widgets" },
    undefined, // blank
    location(1), // intro
    location(2), // count = ...
    location(3), // outro
  ]);
  // Only the heading advertises itself as a link; rows answer the cursor alone.
  expect(doc.lines.map(({ spans }) => spans[0]?.tier)).toEqual(["link", undefined, "jump", "jump", "jump"]);
});

test("diffDoc side by side leaves the other pane empty on pure adds and removes", () => {
  const doc = diffDoc(
    diffPageWith({
      end: fake("3"),
      later: 0,
      view: { kind: "two", prev: "keep\ndrop me\nend\n", next: "keep\nend\nbrand new\n" },
    }),
    undefined,
    "wrap",
  );
  expect(docText(doc)).toMatchInlineSnapshot(`
    "api.ts in widgets (up to 333333333333)

    1 keep                                                        │ 1 keep
    2 drop me                                                     │
    3 end                                                         │ 2 end
                                                                  │ 3 brand new"
  `);
  const location = (line: number) => ({ kind: "location", file: "api.ts", line });
  expect(doc.lines.slice(2).map((_, i) => targetAt(doc, i + 2))).toEqual([
    location(1), // keep
    location(2), // drop me: the removal site, where "end" now sits
    location(2), // end
    location(3), // brand new
  ]);
});

test("diffDoc side by side styles an added blank line, so hosts wash it like its neighbors", () => {
  const doc = diffDoc(
    diffPageWith({ end: fake("3"), later: 0, view: { kind: "two", prev: "one\ntwo\n", next: "one\n\nnew\ntwo\n" } }),
    undefined,
    "wrap",
  );
  const styles = doc.lines.map(({ spans }) => spans.flatMap(({ text, style }) => (style ? [[text, style]] : [])));
  expect(styles.filter((line) => line.some(([, style]) => style === "added"))).toEqual([
    [["", "added"]],
    [["new", "added"]],
  ]);
});

test("diffDoc side by side trims context and separates hunks with a blank row", () => {
  const lines = ["ant", "bee", "cat", "dog", "eel", "fox", "gnu", "hen", "ibis"];
  const prev = `${lines.join("\n")}\n`;
  const next = `${lines.join("\n").replace("bee", "BEE").replace("hen", "HEN")}\n`;
  const doc = diffDoc(diffPageWith({ end: fake("3"), later: 0, view: { kind: "two", prev, next } }), 1, "wrap");
  expect(docText(doc)).toMatchInlineSnapshot(`
    "api.ts in widgets (up to 333333333333)

    1 ant                                                         │ 1 ant
    2 bee                                                         │
                                                                  │ 2 BEE
    3 cat                                                         │ 3 cat

    7 gnu                                                         │ 7 gnu
    8 hen                                                         │
                                                                  │ 8 HEN
    9 ibis                                                        │ 9 ibis"
  `);
});

test("diffDoc side by side wraps a long row into anchored continuation lines", () => {
  const long = (word: string) => `const banner = "${word}: ${"x".repeat(70)}";\n`;
  const doc = diffDoc(
    diffPageWith({ end: fake("3"), later: 0, view: { kind: "two", prev: long("before"), next: long("after") } }),
    undefined,
    "wrap",
  );
  expect(docText(doc)).toMatchInlineSnapshot(`
    "api.ts in widgets (up to 333333333333)

    1 const banner = "before: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx│ 1 const banner = "after: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
      xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";                        │   xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";"
  `);
  const location = (line: number) => ({ kind: "location", file: "api.ts", line });
  expect(doc.lines.slice(2).map((_, i) => targetAt(doc, i + 2))).toEqual([location(1), location(1)]);
});

test("diffDoc side by side truncates a long row to one line when asked", () => {
  const long = (word: string) => `const banner = "${word}: ${"x".repeat(70)}";\n`;
  const doc = diffDoc(
    diffPageWith({ end: fake("3"), later: 0, view: { kind: "two", prev: long("before"), next: long("after") } }),
    undefined,
    "truncate",
  );
  expect(docText(doc)).toMatchInlineSnapshot(`
    "api.ts in widgets (up to 333333333333)

    1 const banner = "before: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx│ 1 const banner = "after: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  `);
});

test("diffDoc side by side keeps whitespace changes visible where they are semantic", () => {
  const doc = diffDoc(
    {
      change: widgets,
      file: parseFilePath("script.py"),
      round: {
        end: fake("3"),
        later: 0,
        view: { kind: "two", prev: "def f():\n  go()\n", next: "def f():\n    go()\n" },
      },
    },
    undefined,
    "wrap",
  );
  expect(docText(doc)).toMatchInlineSnapshot(`
    "script.py in widgets (up to 333333333333)

    1 def f():                                                    │ 1 def f():
    2   go()                                                      │ 2     go()"
  `);
});

test("diffDoc side by side leaves a four-way diff unified, which patdiff4 alone renders", () => {
  const page = diffPageWith({
    end: fake("4"),
    later: 0,
    view: {
      kind: "four",
      revs: { b1: fake("1"), b2: fake("2"), f1: fake("3"), f2: fake("4") },
      contents: { b1: "one\n", b2: "ONE\n", f1: "one\nchild\n", f2: "ONE!\nchild\n" },
    },
  });
  expect(docText(diffDoc(page, undefined, "wrap"))).toBe(docText(diffDoc(page)));
});

test("diffDoc side by side reports binary versions and empty diffs like the unified view", () => {
  const binary = diffPageWith({ end: fake("3"), later: 0, view: { kind: "two", prev: "a\0b\n", next: "c\0d\n" } });
  expect(docText(diffDoc(binary, undefined, "wrap"))).toBe(docText(diffDoc(binary)));
  const empty = diffPageWith({ end: fake("3"), later: 0, view: { kind: "two", prev: "same\n", next: "same\n" } });
  expect(docText(diffDoc(empty, undefined, "truncate"))).toBe(docText(diffDoc(empty)));
});

test("diffDoc with no review left says so", () => {
  expect(docText(diffDoc(diffPageWith(undefined)))).toMatchInlineSnapshot(`
    "api.ts in widgets

    Nothing left to review."
  `);
});

function snapshotWith(files: readonly string[], secondRound: readonly string[] = []): ChangeSnapshot {
  const round = (end: CommitHash, names: readonly string[]) => ({
    end,
    files: new Map(names.map((name) => [parseFilePath(name), { kind: "span", start: fake("1") } as const])),
  });
  return {
    change: widgets,
    user: userName("alice@example.com"),
    base: fake("1"),
    tip: fake("3"),
    rounds: [round(fake("2"), files), ...(secondRound.length === 0 ? [] : [round(fake("3"), secondRound)])],
  };
}

/** A backend of which only `appendLog` is exercised, recording what lands. */
function appendOnly(appended: LogEntry[][]): Backend {
  return {
    appendLog: async (_change, entries) => {
      appended.push([...entries]);
    },
  } as Backend;
}

const at = timestampMs(1748000000000);

test("markReviewed records the snapshot's round end and marks the file off", () => {
  const appended: LogEntry[][] = [];
  const snapshot = snapshotWith(["a.ts", "b.ts", "c.ts"]);
  const result = markReviewed(appendOnly(appended), () => at, snapshot, parseFilePath("b.ts"));
  expect(result.kind).toBe("marked");
  if (result.kind !== "marked") {
    throw new Error("unreachable");
  }
  expect(result.next).toBe("c.ts");
  expect(appended).toEqual([
    [
      {
        timestamp: at,
        user: userName("alice@example.com"),
        action: { kind: "review", file: parseFilePath("b.ts"), base: fake("1"), tip: fake("2") },
      },
    ],
  ]);
  expect(reviewPage(result.snapshot)).toEqual({
    change: widgets,
    round: { end: fake("2"), files: [parseFilePath("a.ts"), parseFilePath("c.ts")], later: 0 },
  });
});

test("marking past the last file wraps to the earliest unmarked, then ends the round", () => {
  const appended: LogEntry[][] = [];
  const backend = appendOnly(appended);
  const first = markReviewed(backend, () => at, snapshotWith(["a.ts", "c.ts"], ["z.ts"]), parseFilePath("c.ts"));
  if (first.kind !== "marked") {
    throw new Error("unreachable");
  }
  expect(first.next).toBe("a.ts");
  const second = markReviewed(backend, () => at, first.snapshot, parseFilePath("a.ts"));
  if (second.kind !== "marked") {
    throw new Error("unreachable");
  }
  // The emptied round drops away; the next round takes over on the review page.
  expect(second.next).toBeUndefined();
  expect(reviewPage(second.snapshot)).toEqual({
    change: widgets,
    round: { end: fake("3"), files: [parseFilePath("z.ts")], later: 0 },
  });
  expect(appended).toHaveLength(2);
});

test("markReviewed of a file with no review pending records nothing", () => {
  const appended: LogEntry[][] = [];
  const result = markReviewed(appendOnly(appended), () => at, snapshotWith(["a.ts"]), parseFilePath("other.ts"));
  expect(result).toEqual({ kind: "nothing-left" });
  expect(appended).toEqual([]);
});

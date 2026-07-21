import {
  type Backend,
  type ChangedFile,
  type LogEntry,
  parseBranchName,
  parseCommitHash,
  parseFilePath,
  type Revision,
  timestampMs,
  userName,
} from "cabaret-core";
import { expect, test } from "vitest";
import {
  type ChangeSnapshot,
  type DiffPage,
  type DiffsPage,
  diffDoc,
  diffsDoc,
  docText,
  markReviewed,
  neighborFiles,
  reviewDoc,
  reviewPage,
  targetAt,
} from "../index.js";

function fake(digit: string): Revision {
  return parseCommitHash(digit.repeat(40));
}

/** A round entry for a file the diff changes in place. */
function file(name: string): ChangedFile {
  return { path: parseFilePath(name), source: undefined };
}

const widgets = parseBranchName("widgets");

test("reviewDoc lists the files left", () => {
  const doc = reviewDoc({
    change: widgets,
    as: undefined,
    conflicts: [],
    left: { tip: fake("3"), files: [file("api.ts"), file("ui.ts")] },
  });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "Review widgets
    ==============

    Reviewing up to 333333333333.

      api.ts
      ui.ts"
  `);
});

test("reviewDoc names a moved or copied file with its source, targeting its new path", () => {
  const doc = reviewDoc({
    change: widgets,
    as: undefined,
    conflicts: [],
    left: {
      tip: fake("3"),
      files: [
        { path: parseFilePath("bylaws.ts"), source: { path: parseFilePath("charter.ts"), copied: true } },
        { path: parseFilePath("new/api.ts"), source: { path: parseFilePath("old/api.ts"), copied: false } },
        file("ui.ts"),
      ],
    },
  });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "Review widgets
    ==============

    Reviewing up to 333333333333.

      charter.ts => bylaws.ts
      old/api.ts -> new/api.ts
      ui.ts"
  `);
  expect(targetAt(doc, 5)).toEqual({ kind: "file", change: "widgets", file: "bylaws.ts" });
  expect(targetAt(doc, 6)).toEqual({ kind: "file", change: "widgets", file: "new/api.ts" });
});

test("reviewDoc targets the first file left from every line but a file's own", () => {
  const doc = reviewDoc({
    change: widgets,
    as: undefined,
    conflicts: [],
    left: { tip: fake("3"), files: [file("api.ts"), file("ui.ts")] },
  });
  const api = { kind: "file", change: "widgets", file: "api.ts" };
  expect(doc.lines.map((_, i) => targetAt(doc, i))).toEqual([
    api, // the heading: no way back to the change
    api, // its underline
    api, // blank
    api, // "Reviewing up to ..."
    api, // blank
    api, // api.ts's own line
    { kind: "file", change: "widgets", file: "ui.ts" },
  ]);
  // Only the file names advertise as links; the rest answers the cursor alone.
  expect(doc.lines.map(({ spans }) => spans.find(({ target }) => target !== undefined)?.tier)).toEqual([
    "jump",
    "jump",
    "jump",
    "jump",
    "jump",
    "link",
    "link",
  ]);
});

test("reviewDoc as another user says so and routes files to their diffs", () => {
  const doc = reviewDoc({
    change: widgets,
    as: userName("bob@example.com"),
    conflicts: [],
    left: { tip: fake("3"), files: [file("api.ts"), file("ui.ts")] },
  });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "Review widgets as bob@example.com
    =================================

    Reviewing up to 333333333333.

      api.ts
      ui.ts"
  `);
  const asBob = (file: string) => ({ kind: "file", change: "widgets", file, as: "bob@example.com" });
  expect(targetAt(doc, 0)).toEqual(asBob("api.ts"));
  expect(targetAt(doc, 5)).toEqual(asBob("api.ts"));
  expect(targetAt(doc, 6)).toEqual(asBob("ui.ts"));
});

test("reviewDoc with conflicts asks for the fix instead of offering files", () => {
  const doc = reviewDoc({
    change: widgets,
    as: undefined,
    conflicts: [parseFilePath("api.ts"), parseFilePath("ui.ts")],
    left: undefined,
  });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "Review widgets
    ==============

    Unresolved conflicts in api.ts, ui.ts; fix the markers and amend."
  `);
  expect(doc.lines.map((_, i) => targetAt(doc, i))).toEqual([undefined, undefined, undefined, undefined]);
});

test("reviewDoc with nothing left says so, targeting nothing", () => {
  const doc = reviewDoc({ change: widgets, as: undefined, conflicts: [], left: undefined });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "Review widgets
    ==============

    Nothing left to review."
  `);
  expect(doc.lines.map((_, i) => targetAt(doc, i))).toEqual([undefined, undefined, undefined, undefined]);
});

function diffPageWith(left: DiffPage["left"]): DiffPage {
  return { change: widgets, file: parseFilePath("api.ts"), as: undefined, left };
}

test("diffDoc titles a moved file by both sides, a pure move showing no hunks", () => {
  const doc = diffDoc(
    diffPageWith({
      tip: fake("3"),
      source: { path: parseFilePath("old/api.ts"), copied: false },
      view: { kind: "two", prev: "same\n", next: "same\n" },
    }),
  );
  expect(docText(doc)).toMatchInlineSnapshot(`
    "old/api.ts -> api.ts in widgets (up to 333333333333)

    Moved with no content changes."
  `);
});

test("diffDoc titles a copied file with its source and shows only the delta", () => {
  const doc = diffDoc(
    diffPageWith({
      tip: fake("3"),
      source: { path: parseFilePath("charter.ts"), copied: true },
      view: { kind: "two", prev: "shared\nclosing\n", next: "shared\nbylaws closing\n" },
    }),
  );
  expect(docText(doc)).toMatchInlineSnapshot(`
    "charter.ts => api.ts in widgets (up to 333333333333)

    -1,2 +1,2
    shared
    bylaws closing"
  `);
});

test("diffDoc renders a two-way diff bare of marks, styling its added and removed lines", () => {
  const doc = diffDoc(
    diffPageWith({
      tip: fake("3"),
      source: undefined,
      view: { kind: "two", prev: "shared\ngone\n", next: "shared\nhere\n" },
    }),
  );
  expect(docText(doc)).toMatchInlineSnapshot(`
    "api.ts in widgets (up to 333333333333)

    -1,2 +1,2
    shared
    gone
    here"
  `);
  const styles = doc.lines.map(({ spans }) => spans.map(({ text, style }) => [text, style]));
  expect(styles.filter((line) => line.some(([, style]) => style !== undefined))).toEqual([
    [["api.ts in widgets (up to 333333333333)", "heading"]],
    [["-1,2 +1,2", "hunk"]],
    [["gone", "removed"]],
    [["here", "added"]],
  ]);
});

test("diffDoc anchors each hunk line to its place in the new copy, on the jump tier", () => {
  const doc = diffDoc(
    diffPageWith({
      tip: fake("3"),
      source: undefined,
      view: { kind: "two", prev: "shared\ngone\n", next: "shared\nhere\n" },
    }),
  );
  const location = (line: number) => ({ kind: "location", change: "widgets", file: "api.ts", line });
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
  const doc = diffDoc(diffPageWith({ tip: fake("3"), source: undefined, view: { kind: "two", prev, next } }), 1);
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
  // Each hunk folds down to its header; the blank separator stays outside.
  expect(doc.folds).toEqual([
    { start: 2, end: 6 },
    { start: 8, end: 12 },
  ]);
});

test("diffDoc shows the whole file in one hunk at context -1", () => {
  const lines = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  const prev = `${lines.join("\n")}\n`;
  const next = `${lines.join("\n").replace("two", "TWO").replace("eight", "EIGHT")}\n`;
  const doc = diffDoc(diffPageWith({ tip: fake("3"), source: undefined, view: { kind: "two", prev, next } }), -1);
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

test("diffDoc styles an added blank line, so hosts wash it like its neighbors", () => {
  const doc = diffDoc(
    diffPageWith({
      tip: fake("3"),
      source: undefined,
      view: { kind: "two", prev: "one\ntwo\n", next: "one\n\nnew\ntwo\n" },
    }),
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
  const doc = diffDoc(
    diffPageWith({
      tip: fake("3"),
      source: undefined,
      view: { kind: "two", prev, next: `${prev}tail\n` },
    }),
  );
  const added = doc.lines.findIndex(({ spans }) =>
    spans.some(({ text, style }) => text === "tail" && style === "added"),
  );
  expect(targetAt(doc, added)).toEqual({ kind: "location", change: "widgets", file: "api.ts", line: 41 });
});

test("diffDoc keeps a long modified line whole instead of splitting it", () => {
  const long = (word: string) => `const banner = "${word}: ${"x".repeat(90)}";\n`;
  const doc = diffDoc(
    diffPageWith({
      tip: fake("3"),
      source: undefined,
      view: { kind: "two", prev: long("before"), next: long("after") },
    }),
  );
  const hunk = doc.lines.slice(3).map(({ spans }) => spans.map(({ text, style }) => [text, style]));
  const tail = `: ${"x".repeat(90)}";`;
  expect(hunk).toEqual([
    [
      ['const banner = "', "removed"],
      ["before", "removed-word"],
      [tail, "removed"],
    ],
    [
      ['const banner = "', "added"],
      ["after", "added-word"],
      [tail, "added"],
    ],
  ]);
  expect(targetAt(doc, 4)).toEqual({ kind: "location", change: "widgets", file: "api.ts", line: 1 });
});

test("diffDoc emphasizes the changed words within a modified line", () => {
  const doc = diffDoc(
    diffPageWith({
      tip: fake("3"),
      source: undefined,
      view: { kind: "two", prev: "dogs are the best pets\n", next: "dogs are the cutest pets\n" },
    }),
  );
  const hunk = doc.lines.slice(2).map(({ spans }) => spans.map(({ text, style }) => [text, style]));
  expect(hunk).toEqual([
    [["-1,1 +1,1", "hunk"]],
    [
      ["dogs are the", "removed"],
      [" best", "removed-word"],
      [" pets", "removed"],
    ],
    [
      ["dogs are the", "added"],
      [" cutest", "added-word"],
      [" pets", "added"],
    ],
  ]);
  // The line's target and tier ride its first span alone.
  expect(doc.lines[3]?.spans.map(({ target, tier }) => [target, tier])).toEqual([
    [{ kind: "location", change: "widgets", file: "api.ts", line: 1 }, "jump"],
    [undefined, undefined],
    [undefined, undefined],
  ]);
});

test("diffDoc unifies a line that only gained words, styling just those words", () => {
  const doc = diffDoc(
    diffPageWith({
      tip: fake("3"),
      source: undefined,
      view: { kind: "two", prev: "dogs are best pets\ntail\n", next: "dogs are the very best pets\ntail\n" },
    }),
  );
  const hunk = doc.lines.slice(2).map(({ spans }) => spans.map(({ text, style }) => [text, style]));
  expect(hunk).toEqual([
    [["-1,2 +1,2", "hunk"]],
    [
      ["dogs are", undefined],
      [" the very", "added-word"],
      [" best pets", undefined],
    ],
    [["tail", undefined]],
  ]);
  // The unified line lives in both copies; lines after it stay anchored.
  expect(targetAt(doc, 3)).toEqual({ kind: "location", change: "widgets", file: "api.ts", line: 1 });
  expect(targetAt(doc, 4)).toEqual({ kind: "location", change: "widgets", file: "api.ts", line: 2 });
});

test("diffDoc unifies a line that only lost words, keeping the old line as the marked superset", () => {
  const doc = diffDoc(
    diffPageWith({
      tip: fake("3"),
      source: undefined,
      view: { kind: "two", prev: "dogs are the very best pets\ntail\n", next: "dogs are best pets\ntail\n" },
    }),
  );
  const hunk = doc.lines.slice(2).map(({ spans }) => spans.map(({ text, style }) => [text, style]));
  expect(hunk).toEqual([
    [["-1,2 +1,2", "hunk"]],
    [
      ["dogs are", undefined],
      [" the very", "removed-word"],
      [" best pets", undefined],
    ],
    [["tail", undefined]],
  ]);
});

test("diffDoc keeps line anchors across a unified join, whose boundary the new copy lost", () => {
  const doc = diffDoc(
    diffPageWith({
      tip: fake("3"),
      source: undefined,
      view: { kind: "two", prev: "keep alpha\nbeta tail\nlast\n", next: "keep tail\nlast\n" },
    }),
  );
  const hunk = doc.lines.slice(2).map(({ spans }) => spans.map(({ text, style }) => [text, style]));
  expect(hunk).toEqual([
    [["-1,3 +1,2", "hunk"]],
    [
      ["keep", undefined],
      [" alpha", "removed-word"],
    ],
    [
      ["beta", "removed-word"],
      [" tail", undefined],
    ],
    [["last", undefined]],
  ]);
  // Both halves of the joined line anchor at the join; "last" is unmoved past it.
  expect(targetAt(doc, 3)).toEqual({ kind: "location", change: "widgets", file: "api.ts", line: 1 });
  expect(targetAt(doc, 4)).toEqual({ kind: "location", change: "widgets", file: "api.ts", line: 1 });
  expect(targetAt(doc, 5)).toEqual({ kind: "location", change: "widgets", file: "api.ts", line: 2 });
});

test("diffDoc leaves a line replaced wholesale as one plain span", () => {
  const doc = diffDoc(
    diffPageWith({
      tip: fake("3"),
      source: undefined,
      view: { kind: "two", prev: "shared\ngone\n", next: "shared\nfresh words\n" },
    }),
  );
  const hunk = doc.lines.slice(2).map(({ spans }) => spans.map(({ text, style }) => [text, style]));
  expect(hunk).toEqual([
    [["-1,2 +1,2", "hunk"]],
    [["shared", undefined]],
    [["gone", "removed"]],
    [["fresh words", "added"]],
  ]);
});

test("diffDoc leaves a context line unstyled even when its text starts like a mark", () => {
  const doc = diffDoc(
    diffPageWith({
      tip: fake("3"),
      source: undefined,
      view: { kind: "two", prev: "-|weird\n", next: "-|weird\nnew\n" },
    }),
  );
  const hunk = doc.lines.slice(2).map(({ spans }) => spans.map(({ text, style }) => [text, style]));
  expect(hunk).toEqual([[["-1,1 +1,2", "hunk"]], [["-|weird", undefined]], [["new", "added"]]]);
});

test("diffDoc omits the redundant file-name lines for a newly added file", () => {
  const doc = diffDoc(
    diffPageWith({
      tip: fake("3"),
      source: undefined,
      view: { kind: "two", prev: undefined, next: "new\n" },
    }),
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
      tip: fake("4"),
      source: undefined,
      view: {
        kind: "four",
        revs: { b1: fake("1"), b2: fake("2"), f1: fake("3"), f2: fake("4") },
        contents: { b1: "one\n", b2: "ONE\n", f1: "one\nchild\n", f2: "ONE!\nchild\n" },
      },
    }),
  );
  // The buffer holds bare code under the conflict's hint; the two diff
  // channels ride entirely on styles.
  expect(docText(doc)).toMatchInlineSnapshot(`
    "api.ts in widgets (up to 444444444444)

    Conflicting changes: the reviewed diff compared to the current diff
    one
    ONE
    ONE!
    child"
  `);
  expect(doc.lines.map(({ spans }) => spans.map(({ text, style }) => [text, style]))).toEqual([
    [["api.ts in widgets (up to 444444444444)", "heading"]],
    [],
    [["Conflicting changes: the reviewed diff compared to the current diff", "heading"]],
    [["one", "old-diff-context"]], // the reviewed diff's context, gone from the current one
    [["ONE", "new-diff-removed"]], // a removal only the current diff makes
    [["ONE!", "new-diff-added"]], // an addition only the current diff makes
    [["child", "added"]], // both diffs agree: plain two-way styling
  ]);
  // Lines anchor to their home in the new tip where they have one: added and
  // context lines directly, and lines with no new-tip content not at all.
  const location = (line: number) => ({ kind: "location", change: "widgets", file: "api.ts", line });
  const rendered = docText(doc).split("\n");
  const targetOf = (text: string) => targetAt(doc, rendered.indexOf(text));
  expect(targetOf("ONE!")).toEqual(location(1));
  expect(targetOf("child")).toEqual(location(2));
  expect(targetOf("ONE")).toBeUndefined(); // removed before its hunk's first anchor
  expect(targetOf("one")).toBeUndefined(); // the old diff only: no new-tip content
  // Anchored lines sit on the jump tier, never advertised as links.
  const tierOf = (text: string) => doc.lines[rendered.indexOf(text)]?.spans[0]?.tier;
  expect(tierOf("ONE!")).toBe("jump");
  expect(tierOf("one")).toBeUndefined();
  // The conflict folds down to its hint.
  expect(doc.folds).toEqual([{ start: 2, end: 6 }]);
});

test("diffDoc anchors a story block through its to-side's equivalence with the new tip", () => {
  // b2 equals f2, so the kept-base-change block (b1 -> b2) anchors its lines
  // in the new tip by sharing the to-side's positions; the dropped block
  // (b1 -> f1) never touches the new tip and carries no targets.
  const doc = diffDoc(
    diffPageWith({
      tip: fake("4"),
      source: undefined,
      view: {
        kind: "four",
        revs: { b1: fake("1"), b2: fake("2"), f1: fake("3"), f2: fake("4") },
        contents: { b1: "a\nb\nc\n", b2: "a\nB\nc\n", f1: "a\nx\nc\n", f2: "a\nB\nc\n" },
      },
    }),
  );
  expect(docText(doc)).toMatchInlineSnapshot(`
    "api.ts in widgets (up to 444444444444)

    This feature change was dropped... :
    -1,3 +1,3 old base → old tip
    a
    b
    x
    c

    ... in favor of this base change:
    -1,3 +1,3 old base → new base, new tip
    a
    b
    B
    c"
  `);
  const location = (line: number) => ({ kind: "location", change: "widgets", file: "api.ts", line });
  expect(doc.lines.map((_, i) => targetAt(doc, i))).toEqual([
    { kind: "change", change: "widgets" },
    undefined, // blank
    undefined, // "This feature change was dropped... :"
    undefined, // -1,3 +1,3 old base -> old tip
    undefined, // a
    undefined, // b
    undefined, // x
    undefined, // c
    undefined, // blank
    undefined, // "... in favor of this base change:"
    location(1), // -1,3 +1,3 old base -> new base, new tip
    location(1), // a
    location(2), // b: the removal site in the new tip
    location(2), // B
    location(3), // c
  ]);
});

test("diffDoc anchors a conflict's agreed removal at the running insertion point", () => {
  // Both diffs drop X, so the line rides the ddiff unmarked; it follows the
  // anchored context line "a" and anchors where its replacement would sit.
  const doc = diffDoc(
    diffPageWith({
      tip: fake("4"),
      source: undefined,
      view: {
        kind: "four",
        revs: { b1: fake("1"), b2: fake("2"), f1: fake("3"), f2: fake("4") },
        contents: { b1: "a\nX\nc\n", b2: "a\nX\nC\n", f1: "a\nc\n", f2: "a\nC\n" },
      },
    }),
  );
  expect(docText(doc)).toMatchInlineSnapshot(`
    "api.ts in widgets (up to 444444444444)

    Conflicting changes: the reviewed diff compared to the current diff
    a
    X
    c
    C"
  `);
  const location = (line: number) => ({ kind: "location", change: "widgets", file: "api.ts", line });
  expect(doc.lines.map((_, i) => [targetAt(doc, i), doc.lines[i]?.spans[0]?.style])).toEqual([
    [{ kind: "change", change: "widgets" }, "heading"],
    [undefined, undefined], // blank
    [undefined, "heading"], // the conflict hint
    [location(1), undefined], // a: context both diffs share
    [location(2), "removed"], // X: both diffs remove it, anchored at the site
    [location(2), "old-diff-context"], // c: the old diff's context
    [location(2), "new-diff-context"], // C: the new diff's context
  ]);
});

test("diffDoc folds each four-way block's hunks to their headers", () => {
  // Two well-separated changes, so the diff aligns into two hunks: a plain
  // diff extension, then a both-changes-dropped region shown as two blocks.
  const contents = (second: string, ninth: string): string => `top\n${second}\nm1\nm2\nm3\nm4\nm5\n${ninth}\nbot\n`;
  const doc = diffDoc(
    diffPageWith({
      tip: fake("4"),
      source: undefined,
      view: {
        kind: "four",
        revs: { b1: fake("1"), b2: fake("2"), f1: fake("3"), f2: fake("4") },
        contents: {
          b1: contents("alpha", "omega"),
          b2: contents("alpha", "OMEGA"),
          f1: contents("alpha1", "omega!"),
          f2: contents("alpha2", "omega"),
        },
      },
    }),
    1,
  );
  // The whole page reads as plain diffs: hint sentences over the hunks of
  // the pairs each hunk's class chose, headers naming the pair.
  expect(docText(doc)).toMatchInlineSnapshot(`
    "api.ts in widgets (up to 444444444444)

    -1,3 +1,3 old tip → new tip
    top
    alpha1
    alpha2
    m1

    Diverging changes in the old-tip and the new-base were both dropped
    -7,3 +7,3 old tip → old base, new tip
    m5
    omega!
    bot

    -7,3 +7,3 new base → old base, new tip
    m5
    OMEGA
    omega
    bot"
  `);
  const text = docText(doc).split("\n");
  expect(doc.folds.map(({ start, end }) => [text[start], text[end]])).toEqual([
    ["-1,3 +1,3 old tip → new tip", "m1"],
    ["-7,3 +7,3 old tip → old base, new tip", "bot"],
    ["-7,3 +7,3 new base → old base, new tip", "bot"],
  ]);
});

test("diffDoc with an empty diff points at marking the file reviewed", () => {
  const doc = diffDoc(
    diffPageWith({
      tip: fake("3"),
      source: undefined,
      view: { kind: "two", prev: "same\n", next: "same\n" },
    }),
  );
  expect(docText(doc)).toMatchInlineSnapshot(`
    "api.ts in widgets (up to 333333333333)

    No differences left to read."
  `);
});

test("diffDoc reports binary versions instead of diffing them", () => {
  const doc = diffDoc(
    diffPageWith({
      tip: fake("3"),
      source: undefined,
      view: { kind: "two", prev: "a\0b\n", next: "c\0d\n" },
    }),
  );
  expect(docText(doc)).toMatchInlineSnapshot(`
    "api.ts in widgets (up to 333333333333)

    Binary versions of api.ts differ"
  `);
});

test("diffDoc with no review left says so", () => {
  expect(docText(diffDoc(diffPageWith(undefined)))).toMatchInlineSnapshot(`
    "api.ts in widgets

    Nothing left to review."
  `);
});

test("diffDoc as another user names them in the title", () => {
  const doc = diffDoc({
    ...diffPageWith({
      tip: fake("3"),
      source: undefined,
      view: { kind: "two", prev: "gone\n", next: "here\n" },
    }),
    as: userName("bob@example.com"),
  });
  expect(docText(doc)).toMatchInlineSnapshot(`
    "api.ts in widgets as bob@example.com (up to 333333333333)

    -1,1 +1,1
    gone
    here"
  `);
});

function snapshotWith(files: readonly string[], conflicts: readonly string[] = []): ChangeSnapshot {
  return {
    change: widgets,
    user: userName("alice@example.com"),
    as: undefined,
    reviewing: "everyone",
    asked: true,
    base: fake("1"),
    tip: fake("3"),
    conflicts: conflicts.map(parseFilePath),
    left: new Map(files.map((name) => [parseFilePath(name), { kind: "fresh", source: undefined } as const])),
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

test("markReviewed records the snapshot's tip and marks the file off", () => {
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
        action: { kind: "review", file: parseFilePath("b.ts"), base: fake("1"), tip: fake("3") },
      },
    ],
  ]);
  expect(reviewPage(result.snapshot)).toEqual({
    change: widgets,
    conflicts: [],
    left: { tip: fake("3"), files: [file("a.ts"), file("c.ts")] },
  });
});

test("marking past the last file wraps to the earliest unmarked, then ends review", () => {
  const appended: LogEntry[][] = [];
  const backend = appendOnly(appended);
  const first = markReviewed(backend, () => at, snapshotWith(["a.ts", "c.ts"]), parseFilePath("c.ts"));
  if (first.kind !== "marked") {
    throw new Error("unreachable");
  }
  expect(first.next).toBe("a.ts");
  const second = markReviewed(backend, () => at, first.snapshot, parseFilePath("a.ts"));
  if (second.kind !== "marked") {
    throw new Error("unreachable");
  }
  // Review is done; the review page takes over and says so.
  expect(second.next).toBeUndefined();
  expect(reviewPage(second.snapshot)).toEqual({ change: widgets, conflicts: [], left: undefined });
  expect(appended).toHaveLength(2);
});

test("a conflicted snapshot drops its review and refuses to mark, even asked", () => {
  const snapshot = snapshotWith(["a.ts", "b.ts"], ["a.ts"]);
  expect(reviewPage(snapshot)).toEqual({ change: widgets, conflicts: [parseFilePath("a.ts")], left: undefined });
  const appended: LogEntry[][] = [];
  expect(() => markReviewed(appendOnly(appended), () => at, snapshot, parseFilePath("b.ts"), true)).toThrow(
    '"widgets" has unresolved conflicts in a.ts; fix the markers and amend',
  );
  expect(appended).toEqual([]);
});

test("markReviewed through a borrowed snapshot records the borrowed user", () => {
  const appended: LogEntry[][] = [];
  const bob = userName("bob@example.com");
  const snapshot = { ...snapshotWith(["a.ts"]), user: bob, as: bob };
  const result = markReviewed(appendOnly(appended), () => at, snapshot, parseFilePath("a.ts"));
  expect(result.kind).toBe("marked");
  expect(appended).toEqual([
    [
      {
        timestamp: at,
        user: bob,
        action: { kind: "review", file: parseFilePath("a.ts"), base: fake("1"), tip: fake("3") },
      },
    ],
  ]);
});

test("neighborFiles names the files beside one, ending at the edges", () => {
  const left = snapshotWith(["a.ts", "b.ts", "c.ts"]).left;
  expect(neighborFiles(left, parseFilePath("b.ts"))).toEqual({ prev: "a.ts", next: "c.ts" });
  expect(neighborFiles(left, parseFilePath("a.ts"))).toEqual({ prev: undefined, next: "b.ts" });
  expect(neighborFiles(left, parseFilePath("c.ts"))).toEqual({ prev: "b.ts", next: undefined });
  expect(neighborFiles(left, parseFilePath("other.ts"))).toBeUndefined();
});

test("markReviewed of a file with no review pending records nothing", () => {
  const appended: LogEntry[][] = [];
  const result = markReviewed(appendOnly(appended), () => at, snapshotWith(["a.ts"]), parseFilePath("other.ts"));
  expect(result).toEqual({ kind: "nothing-left" });
  expect(appended).toEqual([]);
});

function diffsPageWith(left: DiffsPage["left"], conflicts: DiffsPage["conflicts"] = []): DiffsPage {
  return { change: widgets, as: undefined, conflicts, left };
}

test("diffsDoc renders every file left under its own bar", () => {
  const doc = diffsDoc(
    diffsPageWith({
      tip: fake("3"),
      files: [
        {
          file: parseFilePath("api.ts"),
          source: undefined,
          view: { kind: "two", prev: "shared\ngone\n", next: "shared\nhere\n" },
        },
        {
          file: parseFilePath("docs/notes.md"),
          source: undefined,
          view: { kind: "two", prev: "old\n", next: "new\n" },
        },
        {
          file: parseFilePath("moved.cfg"),
          source: { path: parseFilePath("old.cfg"), copied: false },
          view: { kind: "two", prev: "same\n", next: "same\n" },
        },
      ],
    }),
  );
  expect(docText(doc)).toMatchInlineSnapshot(`
    "Review widgets (up to 333333333333)

    @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ api.ts @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
    -1,2 +1,2
    shared
    gone
    here

    @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ docs/notes.md @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
    -1,1 +1,1
    old
    new

    @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ old.cfg -> moved.cfg @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
    Moved with no content changes."
  `);
  // Each file folds down to its bar, each hunk to its header.
  expect(doc.folds).toEqual([
    { start: 2, end: 6 },
    { start: 3, end: 6 },
    { start: 8, end: 11 },
    { start: 9, end: 11 },
    { start: 13, end: 14 },
  ]);
});

test("diffsDoc targets the change from its title, files from their bars, and lines from their hunks", () => {
  const doc = diffsDoc(
    diffsPageWith({
      tip: fake("3"),
      files: [
        {
          file: parseFilePath("api.ts"),
          source: undefined,
          view: { kind: "two", prev: "shared\ngone\n", next: "shared\nhere\n" },
        },
        {
          file: parseFilePath("docs/notes.md"),
          source: undefined,
          view: { kind: "two", prev: "old\n", next: "new\n" },
        },
      ],
    }),
  );
  const location = (file: string, line: number) => ({ kind: "location", change: "widgets", file, line });
  expect(doc.lines.map((_, i) => targetAt(doc, i))).toEqual([
    { kind: "change", change: "widgets" },
    undefined, // blank
    { kind: "file", change: "widgets", file: "api.ts" },
    location("api.ts", 1), // -1,2 +1,2
    location("api.ts", 1), // shared
    location("api.ts", 2), // gone
    location("api.ts", 2), // here
    undefined, // blank
    { kind: "file", change: "widgets", file: "docs/notes.md" },
    location("docs/notes.md", 1), // -1,1 +1,1
    location("docs/notes.md", 1), // old
    location("docs/notes.md", 1), // new
  ]);
  // Bars advertise themselves as links; diff lines answer the cursor alone.
  expect(doc.lines.map(({ spans }) => spans[0]?.tier)).toEqual([
    "link",
    undefined,
    "link",
    "jump",
    "jump",
    "jump",
    "jump",
    undefined,
    "link",
    "jump",
    "jump",
    "jump",
  ]);
});

test("diffsDoc with conflicts asks for the fix instead of showing diffs", () => {
  const doc = diffsDoc(diffsPageWith(undefined, [parseFilePath("api.ts")]));
  expect(docText(doc)).toMatchInlineSnapshot(`
    "Review widgets

    Unresolved conflicts in api.ts; fix the markers and amend."
  `);
});

test("diffsDoc with nothing left says so", () => {
  const doc = diffsDoc(diffsPageWith(undefined));
  expect(docText(doc)).toMatchInlineSnapshot(`
    "Review widgets

    Nothing left to review."
  `);
});

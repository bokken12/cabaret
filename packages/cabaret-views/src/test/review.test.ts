import { type CommitHash, parseCommitHash, parseFilePath, parseRefName } from "cabaret-core";
import { expect, test } from "vitest";
import { type DiffPage, diffDoc, docText, reviewDoc, targetAt } from "../index.js";

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

test("diffDoc renders a two-way diff, styling its added and removed lines", () => {
  const doc = diffDoc(
    diffPageWith({ end: fake("3"), later: 1, view: { kind: "two", prev: "shared\ngone\n", next: "shared\nhere\n" } }),
  );
  expect(docText(doc)).toMatchInlineSnapshot(`
    "api.ts in widgets
    =================

    Reviewing up to 333333333333; 1 more round follows.

    old/api.ts
    new/api.ts
    -1,2 +1,2
      shared
    -|gone
    +|here"
  `);
  const styles = doc.lines.map(({ spans }) => spans.map(({ text, style }) => [text, style]));
  expect(styles.filter((line) => line.some(([, style]) => style === "added" || style === "removed"))).toEqual([
    [["-|gone", "removed"]],
    [["+|here", "added"]],
  ]);
});

test("diffDoc leaves a context line unstyled even when its text starts like a mark", () => {
  const doc = diffDoc(
    diffPageWith({ end: fake("3"), later: 0, view: { kind: "two", prev: "-|weird\n", next: "-|weird\nnew\n" } }),
  );
  const hunk = doc.lines.slice(5).map(({ spans }) => spans.map(({ text, style }) => [text, style]));
  expect(hunk).toEqual([
    [["old/api.ts", undefined]],
    [["new/api.ts", undefined]],
    [["-1,1 +1,2", undefined]],
    [["  -|weird", undefined]],
    [["+|new", "added"]],
  ]);
});

test("diffDoc names an absent version /dev/null", () => {
  const doc = diffDoc(
    diffPageWith({ end: fake("3"), later: 0, view: { kind: "two", prev: undefined, next: "new\n" } }),
  );
  expect(docText(doc)).toMatchInlineSnapshot(`
    "api.ts in widgets
    =================

    Reviewing up to 333333333333.

    /dev/null
    new/api.ts
    -1,0 +1,1
    +|new"
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
    "api.ts in widgets
    =================

    Reviewing up to 444444444444.

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
});

test("diffDoc with an empty diff points at marking the file reviewed", () => {
  const doc = diffDoc(
    diffPageWith({ end: fake("3"), later: 0, view: { kind: "two", prev: "same\n", next: "same\n" } }),
  );
  expect(docText(doc)).toMatchInlineSnapshot(`
    "api.ts in widgets
    =================

    Reviewing up to 333333333333.

    No differences left to read; mark the file reviewed to record that."
  `);
});

test("diffDoc reports binary versions instead of diffing them", () => {
  const doc = diffDoc(
    diffPageWith({ end: fake("3"), later: 0, view: { kind: "two", prev: "a\0b\n", next: "c\0d\n" } }),
  );
  expect(docText(doc)).toMatchInlineSnapshot(`
    "api.ts in widgets
    =================

    Reviewing up to 333333333333.

    Binary versions of api.ts differ"
  `);
});

test("diffDoc with no review left says so", () => {
  expect(docText(diffDoc(diffPageWith(undefined)))).toMatchInlineSnapshot(`
    "api.ts in widgets
    =================

    Nothing left to review."
  `);
});

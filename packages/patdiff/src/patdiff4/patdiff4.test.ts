import { describe, expect, it, test } from "vitest";
import * as Diamond from "./diamond.js";
import * as DiffAlgo from "./diff-algo.js";
import * as Diff4Class from "./diff4-class.js";
import { diff } from "./patdiff4.js";
import * as Segments from "./segments.js";
import * as Slice from "./slice.js";

describe("Diff4Class.classify", () => {
  // Port of the table in OCaml [diff4_class.ml]: each class is produced by a
  // canonical assignment of values to the four nodes.
  const canonical: Record<Diff4Class.Diff4Class, readonly [number, number, number, number]> = {
    b1_b2_f1_f2: [0, 0, 0, 0],
    b1_b2_f1: [0, 0, 0, 1],
    b1_b2_f2: [0, 0, 1, 0],
    b1_b2__f1_f2: [0, 0, 1, 1],
    b1_b2: [0, 0, 1, 2],
    b1_f1_f2: [0, 1, 0, 0],
    b1_f1__b2_f2: [0, 1, 0, 1],
    b1_f1: [0, 1, 0, 2],
    b1_f2__b2_f1: [0, 1, 1, 0],
    b1_f2: [0, 1, 2, 0],
    b2_f1_f2: [1, 0, 0, 0],
    b2_f1: [1, 0, 0, 2],
    b2_f2: [1, 0, 2, 0],
    f1_f2: [1, 2, 0, 0],
    conflict: [0, 1, 2, 3],
  };

  it("classifies each canonical diamond into its class", () => {
    const classified = Object.fromEntries(
      Object.entries(canonical).map(([cls, [b1, b2, f1, f2]]) => [
        cls,
        Diff4Class.classify({ equal: (a: number, b: number) => a === b, b1, b2, f1, f2 }),
      ]),
    );
    expect(classified).toEqual(Object.fromEntries(Diff4Class.all.map((cls) => [cls, cls])));
  });

  it("renders group syntax consistently with toGroups", () => {
    // Port of the OCaml round-trip test between [to_string] and [to_groups].
    for (const cls of Diff4Class.all) {
      const groups = Diff4Class.toGroups(cls)
        .filter((g) => g.length > 1)
        .map((g) => `{ ${g.map((n) => n.toUpperCase()).join(" ")} }`);
      expect(Diff4Class.toString(cls)).toBe(groups.length === 0 ? "{ }" : groups.join(" "));
    }
  });

  it("visits every node exactly once in toGroups", () => {
    for (const cls of Diff4Class.all) {
      const seen = Diff4Class.toGroups(cls).flat().sort();
      expect(seen).toEqual(["b1", "b2", "f1", "f2"]);
    }
  });
});

describe("Segments.ofFiles", () => {
  // Port of OCaml [patdiff4/lib/test.ml]: slice output of the 4-way
  // alignment, with every applicable view also rendered to catch exceptions.
  const testDoublePdiff = (args: {
    oldBase: readonly number[];
    newBase: readonly number[];
    oldTip: readonly number[];
    newTip: readonly number[];
    expected: readonly Diamond.Diamond<Slice.Slice>[];
  }): void => {
    const ints = (xs: readonly number[]): string => xs.map(String).join("\n");
    const segments = Segments.ofFiles({
      revNames: Diamond.prettyShortRevNamesConst,
      context: 0,
      linesRequiredToSeparateDdiffHunks: 0,
      contents: {
        b1: ints(args.oldBase),
        b2: ints(args.newBase),
        f1: ints(args.oldTip),
        f2: ints(args.newTip),
      },
      forceShouldSplitFilesInHunksForTests: true,
    });
    for (const segment of segments) {
      for (const shownClass of Diff4Class.all.map(Diff4Class.shownClassOf)) {
        if (shownClass === undefined) continue;
        for (const algo of DiffAlgo.selectAlgosForReview(shownClass)) {
          algo.apply({
            includeHunkBreaks: true,
            diff4Class: segment.diff4Class,
            context: 0,
            output: "Ascii",
            slices: segment.slice,
          });
        }
      }
    }
    expect(segments.map((segment) => segment.slice)).toEqual(args.expected);
  };

  const tagged = (
    oldBase: readonly [number, readonly string[]],
    newBase: readonly [number, readonly string[]],
    oldTip: readonly [number, readonly string[]],
    newTip: readonly [number, readonly string[]],
  ): Diamond.Diamond<Slice.Slice> => ({
    b1: Slice.create("old base", oldBase[0], oldBase[1]),
    b2: Slice.create("new base", newBase[0], newBase[1]),
    f1: Slice.create("old tip", oldTip[0], oldTip[1]),
    f2: Slice.create("new tip", newTip[0], newTip[1]),
  });

  test("identical files produce no segments", () => {
    testDoublePdiff({
      oldBase: [0, 1, 2, 3, 4, 5],
      newBase: [0, 1, 2, 3, 4, 5],
      oldTip: [0, 1, 2, 3, 4, 5],
      newTip: [0, 1, 2, 3, 4, 5],
      expected: [],
    });
  });

  test("single-line", () => {
    testDoublePdiff({
      oldBase: [0, 1, 2, 0, 4, 5],
      newBase: [0, 1, 2, 0, 4, 5],
      oldTip: [0, 1, 2, 0, 4, 5],
      newTip: [0, 1, 2, 3, 4, 5],
      expected: [tagged([3, ["0"]], [3, ["0"]], [3, ["0"]], [3, ["3"]])],
    });
  });

  test("wide", () => {
    testDoublePdiff({
      oldBase: [0, 1, 2, 0, 4, 5],
      newBase: [0, 1, 1, 0, 4, 5],
      oldTip: [0, 1, 2, 0, 4, 5],
      newTip: [0, 1, 2, 3, 4, 5],
      expected: [tagged([2, ["2", "0"]], [2, ["1", "0"]], [2, ["2", "0"]], [2, ["2", "3"]])],
    });
  });

  test("multiple different", () => {
    testDoublePdiff({
      oldBase: [0, 10, 2, 11, 4, 12, 6],
      newBase: [0, 20, 2, 21, 4, 22, 6],
      oldTip: [0, 30, 2, 31, 4, 32, 6],
      newTip: [0, 40, 2, 41, 4, 42, 6],
      expected: [
        tagged([1, ["10"]], [1, ["20"]], [1, ["30"]], [1, ["40"]]),
        tagged([3, ["11"]], [3, ["21"]], [3, ["31"]], [3, ["41"]]),
        tagged([5, ["12"]], [5, ["22"]], [5, ["32"]], [5, ["42"]]),
      ],
    });
  });

  test("multi-line, with gap", () => {
    testDoublePdiff({
      oldBase: [0, 11, 20, 0, 30, 40, 0],
      newBase: [0, 10, 21, 0, 30, 40, 0],
      oldTip: [0, 10, 20, 0, 31, 40, 0],
      newTip: [0, 10, 20, 0, 30, 41, 0],
      expected: [
        tagged([1, ["11", "20"]], [1, ["10", "21"]], [1, ["10", "20"]], [1, ["10", "20"]]),
        tagged([4, ["30", "40"]], [4, ["30", "40"]], [4, ["31", "40"]], [4, ["30", "41"]]),
      ],
    });
  });

  test("pairwise equal", () => {
    testDoublePdiff({
      oldBase: [0, 10, 20, 0, 31, 41, 0],
      newTip: [0, 10, 20, 0, 31, 41, 0],
      newBase: [0, 11, 21, 0, 30, 40, 0],
      oldTip: [0, 11, 21, 0, 30, 40, 0],
      expected: [
        tagged([1, ["10", "20"]], [1, ["11", "21"]], [1, ["11", "21"]], [1, ["10", "20"]]),
        tagged([4, ["31", "41"]], [4, ["30", "40"]], [4, ["30", "40"]], [4, ["31", "41"]]),
      ],
    });
  });

  test("pairwise equal not shown b1_f1__b2_f2", () => {
    testDoublePdiff({
      oldBase: [0, 10, 20, 0, 31, 41, 0],
      oldTip: [0, 10, 20, 0, 31, 41, 0],
      newBase: [0, 11, 21, 0, 30, 40, 0],
      newTip: [0, 11, 21, 0, 30, 40, 0],
      expected: [],
    });
  });

  test("pairwise equal not shown b1_b2__f1_f2", () => {
    testDoublePdiff({
      oldBase: [0, 10, 20, 0, 31, 41, 0],
      newBase: [0, 10, 20, 0, 31, 41, 0],
      oldTip: [0, 11, 21, 0, 30, 40, 0],
      newTip: [0, 11, 21, 0, 30, 40, 0],
      expected: [],
    });
  });

  test("different lengths", () => {
    testDoublePdiff({
      oldBase: [],
      newBase: [0],
      oldTip: [0, 1],
      newTip: [0, 1, 2],
      expected: [tagged([0, []], [0, ["0"]], [0, ["0", "1"]], [0, ["0", "1", "2"]])],
    });
  });

  test("context lines keep file order around and between segments", () => {
    // Iron's own tests all run with context 0; this pins the ordering of the
    // common lines distributed as context.
    const contents = (mid: string, last: string): string => `a\nb\nc\n${mid}\nd\ne\nf\ng\nh\n${last}\n`;
    const segments = Segments.ofFiles({
      revNames: Diamond.prettyShortRevNamesConst,
      context: 2,
      linesRequiredToSeparateDdiffHunks: 0,
      contents: {
        b1: contents("mid", "last"),
        b2: contents("mid", "last"),
        f1: contents("mid", "last"),
        f2: contents("MID", "LAST"),
      },
      forceShouldSplitFilesInHunksForTests: true,
    });
    expect(segments.map((segment) => segment.slice)).toEqual([
      tagged(
        [1, ["b", "c", "mid", "d", "e"]],
        [1, ["b", "c", "mid", "d", "e"]],
        [1, ["b", "c", "mid", "d", "e"]],
        [1, ["b", "c", "MID", "d", "e"]],
      ),
      tagged([7, ["g", "h", "last"]], [7, ["g", "h", "last"]], [7, ["g", "h", "last"]], [7, ["g", "h", "LAST"]]),
    ]);
  });

  test("empty hunks", () => {
    testDoublePdiff({
      oldBase: [1, 0, 1, 10, 91, 92, 93, 94, 20, 4, 1],
      newBase: [2, 0, 10, 91, 92, 93, 94, 20, 2, 3, 4, 2],
      oldTip: [3, 0, 1, 10, 91, 92, 93, 94, 20, 2, 3, 4, 3],
      newTip: [4, 0, 1, 10, 91, 92, 93, 94, 20, 3, 4, 4],
      expected: [
        tagged([0, ["1"]], [0, ["2"]], [0, ["3"]], [0, ["4"]]),
        tagged([2, ["1"]], [2, []], [2, ["1"]], [2, ["1"]]),
        tagged([9, []], [8, ["2", "3"]], [9, ["2", "3"]], [9, ["3"]]),
        tagged([10, ["1"]], [11, ["2"]], [12, ["3"]], [11, ["4"]]),
      ],
    });
  });
});

describe("diff", () => {
  const diamond = (b1: string, b2: string, f1: string, f2: string): Diamond.Diamond<string> => ({
    b1,
    b2,
    f1,
    f2,
  });

  test("a rebased diff extension degenerates to one plain 2-way hunk", () => {
    // The base edit at the top carried cleanly into both tips (hidden), and
    // the tip's own evolution at the bottom is far enough away to stay a
    // separate segment, shown as a plain 2-way diff.
    const lines = diff({
      revNames: { b1: "rev-b1", b2: "rev-b2", f1: "rev-f1", f2: "rev-f2" },
      fileNames: Diamond.singleton("greeting.txt"),
      headerFileName: "greeting.txt",
      context: 1,
      linesRequiredToSeparateDdiffHunks: 3,
      contents: diamond(
        "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n",
        "A\nb\nc\nd\ne\nf\ng\nh\ni\nj\n",
        "a\nb\nc\nd\ne\nf\ng\nh\ni\nJ\n",
        "A\nb\nc\nd\ne\nf\ng\nh\ni\nJ\nK\n",
      ),
      output: "Ascii",
    });
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ greeting.txt @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
      old base rev-b1 | old tip rev-f1 | new base rev-b2 | new tip rev-f2
      @@@@@@@@ old tip 10,11 new tip 10,12 @@@@@@@@
        J
      +|K"
    `);
  });

  test("a conflict renders every standard view", () => {
    const lines = diff({
      revNames: { b1: "rev-b1", b2: "rev-b2", f1: "rev-f1", f2: "rev-f2" },
      fileNames: Diamond.singleton("greeting.txt"),
      headerFileName: "greeting.txt",
      context: 1,
      linesRequiredToSeparateDdiffHunks: 3,
      contents: diamond("a\nb\nc\n", "a\nB\nc\n", "a\nx\nc\n", "a\ny\nc\n"),
      output: "Ascii",
    });
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ greeting.txt @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
      old base rev-b1 | old tip rev-f1 | new base rev-b2 | new tip rev-f2
      _
      | @@@@@@@@ View 1/8 : feature-ddiff @@@@@@@@
      | @@@@@@@@ -- old base 1,5 old tip 1,5 @@@@@@@@
      | @@@@@@@@ ++ new base 1,5 new tip 1,5 @@@@@@@@
      |     a
      | ---|b
      | --+|x
      | ++-|B
      | +++|y
      |     c
      |_
      _
      | @@@@@@@@ View 2/8 : base-ddiff @@@@@@@@
      | @@@@@@@@ -- old base 1,5 new base 1,5 @@@@@@@@
      | @@@@@@@@ ++ old tip 1,5 new tip 1,5 @@@@@@@@
      |     a
      | ---|b
      | --+|B
      | ++-|x
      | +++|y
      |     c
      |_
      _
      | @@@@@@@@ View 3/8 : old-tip-to-new-tip @@@@@@@@
      | @@@@@@@@ old tip 1,4 new tip 1,4 @@@@@@@@
      |   a
      | -|x
      | +|y
      |   c
      |_
      _
      | @@@@@@@@ View 4/8 : new-base-to-new-tip @@@@@@@@
      | @@@@@@@@ new base 1,4 new tip 1,4 @@@@@@@@
      |   a
      | -|B
      | +|y
      |   c
      |_
      _
      | @@@@@@@@ View 5/8 : old-base-to-old-tip @@@@@@@@
      | @@@@@@@@ old base 1,4 old tip 1,4 @@@@@@@@
      |   a
      | -|b
      | +|x
      |   c
      |_
      _
      | @@@@@@@@ View 6/8 : old-base-to-new-base @@@@@@@@
      | @@@@@@@@ old base 1,4 new base 1,4 @@@@@@@@
      |   a
      | -|b
      | +|B
      |   c
      |_
      _
      | @@@@@@@@ View 7/8 : old-base-to-new-tip @@@@@@@@
      | @@@@@@@@ old base 1,4 new tip 1,4 @@@@@@@@
      |   a
      | -|b
      | +|y
      |   c
      |_
      _
      | @@@@@@@@ View 8/8 : conflict-resolution @@@@@@@@
      | @@@@@@@@ conflict 1,14 new tip 1,4 @@@@@@@@
      | -|<<<<<<< old tip
      |   a
      | -|x
      | +|y
      |   c
      | -|||||||| old base
      | -|a
      | -|b
      | -|c
      | -|=======
      | -|a
      | -|B
      | -|c
      | -|>>>>>>> new base
      |_"
    `);
  });
});

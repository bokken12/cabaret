import { describe, expect, it, test } from "vitest";
import * as Diamond from "./diamond.js";
import * as DiffAlgo from "./diff-algo.js";
import * as Diff4Class from "./diff4-class.js";
import { diff, type HunksArgs, type StructuredArgs, structuredHunks } from "./patdiff4.js";
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
        DiffAlgo.applyClassView(DiffAlgo.classView(shownClass), {
          includeHunkBreaks: true,
          diff4Class: segment.diff4Class,
          context: 0,
          output: "Ascii",
          slices: segment.slice,
        });
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

  const args = (contents: Diamond.Diamond<string>): HunksArgs => ({
    revNames: { b1: "rev-b1", b2: "rev-b2", f1: "rev-f1", f2: "rev-f2" },
    fileNames: Diamond.singleton("file.txt"),
    headerFileName: "file.txt",
    context: 1,
    linesRequiredToSeparateDdiffHunks: 3,
    contents,
    output: "Ascii",
  });

  const render = (contents: Diamond.Diamond<string>): string =>
    diff(args(contents))
      .map((line) => line.text)
      .join("\n");

  test("f1_f2: a base change dropped in favor of a feature change", () => {
    // The story blocks and the grouped rev names in their headers, modeled
    // on Iron's [test-drop-from-file-review.t].
    expect(render(diamond("a\nb\nc\n", "a\nB\nc\n", "a\nx\nc\n", "a\nx\nc\n"))).toMatchInlineSnapshot(`
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ file.txt @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
      old base rev-b1 | old tip rev-f1 | new base rev-b2 | new tip rev-f2
      _
      | @@@@@@@@ This base change was dropped... : @@@@@@@@
      | @@@@@@@@ old base 1,4 new base 1,4 @@@@@@@@
      |   a
      | -|b
      | +|B
      |   c
      |_
      _
      | @@@@@@@@ ... in favor of this feature change: @@@@@@@@
      | @@@@@@@@ old base 1,4 old tip, new tip 1,4 @@@@@@@@
      |   a
      | -|b
      | +|x
      |   c
      |_"
    `);
  });

  test("b2_f2: a feature change dropped in favor of a base change", () => {
    expect(render(diamond("a\nb\nc\n", "a\nB\nc\n", "a\nx\nc\n", "a\nB\nc\n"))).toMatchInlineSnapshot(`
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ file.txt @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
      old base rev-b1 | old tip rev-f1 | new base rev-b2 | new tip rev-f2
      _
      | @@@@@@@@ This feature change was dropped... : @@@@@@@@
      | @@@@@@@@ old base 1,4 old tip 1,4 @@@@@@@@
      |   a
      | -|b
      | +|x
      |   c
      |_
      _
      | @@@@@@@@ ... in favor of this base change: @@@@@@@@
      | @@@@@@@@ old base 1,4 new tip, new base 1,4 @@@@@@@@
      |   a
      | -|b
      | +|B
      |   c
      |_"
    `);
  });

  test("b1_b2_f2: a reverted feature change shows with its hint", () => {
    expect(render(diamond("a\nb\nc\n", "a\nb\nc\n", "a\nx\nc\n", "a\nb\nc\n"))).toMatchInlineSnapshot(`
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ file.txt @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
      old base rev-b1 | old tip rev-f1 | new base rev-b2 | new tip rev-f2
      @@@@@@@@ A change in the feature was reverted @@@@@@@@
      @@@@@@@@ old tip 1,4 old base, new base, new tip 1,4 @@@@@@@@
        a
      -|x
      +|b
        c"
    `);
  });

  test("b1_f2__b2_f1: the same change dropped from both sides shows with its hint", () => {
    expect(render(diamond("a\nb\nc\n", "a\nx\nc\n", "a\nx\nc\n", "a\nb\nc\n"))).toMatchInlineSnapshot(`
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ file.txt @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
      old base rev-b1 | old tip rev-f1 | new base rev-b2 | new tip rev-f2
      @@@@@@@@ The same change from the old-tip and the new-base was dropped @@@@@@@@
      @@@@@@@@ old tip, new base 1,4 old base, new tip 1,4 @@@@@@@@
        a
      -|x
      +|b
        c"
    `);
  });

  test("hunks of different classes are labeled and rendered independently", () => {
    // One file, two well-separated changes: a plain diff extension and a
    // both-changes-dropped region, whose two blocks nest under its label.
    const contents = (second: string, ninth: string): string => `top\n${second}\nm1\nm2\nm3\nm4\nm5\n${ninth}\nbot\n`;
    expect(
      render({
        b1: contents("alpha", "omega"),
        b2: contents("alpha", "OMEGA"),
        f1: contents("alpha1", "omega!"),
        f2: contents("alpha2", "omega"),
      }),
    ).toMatchInlineSnapshot(`
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ file.txt @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
      old base rev-b1 | old tip rev-f1 | new base rev-b2 | new tip rev-f2
      _
      | @@@@@@@@ Hunk 1/2 @@@@@@@@
      | @@@@@@@@ old tip 1,4 new tip 1,4 @@@@@@@@
      |   top
      | -|alpha1
      | +|alpha2
      |   m1
      |_
      _
      | @@@@@@@@ Hunk 2/2 @@@@@@@@
      | _
      | | @@@@@@@@ Diverging changes in the old-tip and the new-base were both dropped @@@@@@@@
      | | @@@@@@@@ old tip 7,10 old base, new tip 7,10 @@@@@@@@
      | |   m5
      | | -|omega!
      | | +|omega
      | |   bot
      | |_
      | _
      | | @@@@@@@@ new base 7,10 old base, new tip 7,10 @@@@@@@@
      | |   m5
      | | -|OMEGA
      | | +|omega
      | |   bot
      | |_
      |_"
    `);
  });

  const structuredArgs = (contents: Diamond.Diamond<string>): StructuredArgs => ({
    revNames: { b1: "rev-b1", b2: "rev-b2", f1: "rev-f1", f2: "rev-f2" },
    context: 1,
    linesRequiredToSeparateDdiffHunks: 3,
    contents,
  });

  test("structuredHunks describes each class's blocks without rendering", () => {
    const contents = (second: string, ninth: string): string => `top\n${second}\nm1\nm2\nm3\nm4\nm5\n${ninth}\nbot\n`;
    const hunks = structuredHunks(
      structuredArgs({
        b1: contents("alpha", "omega"),
        b2: contents("alpha", "OMEGA"),
        f1: contents("alpha1", "omega!"),
        f2: contents("alpha2", "omega"),
      }),
    );
    expect(
      hunks.map(({ diff4Class, blocks }) => [
        diff4Class,
        blocks.map((block) => (block.kind === "diff2" ? `${block.from}->${block.to}` : "ddiff")),
      ]),
    ).toEqual([
      ["b1_b2", ["f1->f2"]],
      ["b1_f2", ["f1->f2", "b2->f2"]],
    ]);
  });

  test("structuredHunks renders a conflict's feature ddiff as two-channel lines", () => {
    const hunks = structuredHunks(structuredArgs(diamond("a\nb\nc\n", "a\nB\nc\n", "a\nx\nc\n", "a\ny\nc\n")));
    expect(hunks).toHaveLength(1);
    const block = hunks[0]?.blocks[0];
    if (block?.kind !== "ddiff") throw new Error("expected a ddiff block");
    expect(block.hints).toEqual(["Conflicting changes: the reviewed diff compared to the current diff"]);
    expect(block.lines).toEqual([
      { content: "a", diff: "both", kind: "same", provenance: { b1: 1, b2: 1, f1: 1, f2: 1 } },
      { content: "b", diff: "old", kind: "prev", provenance: { b1: 2 } },
      { content: "x", diff: "old", kind: "next", provenance: { f1: 2 } },
      { content: "B", diff: "new", kind: "prev", provenance: { b2: 2 } },
      { content: "y", diff: "new", kind: "next", provenance: { f2: 2 } },
      { content: "c", diff: "both", kind: "same", provenance: { b1: 3, b2: 3, f1: 3, f2: 3 } },
    ]);
  });

  test("structuredHunks of equal versions is empty", () => {
    expect(structuredHunks(structuredArgs(diamond("a\nb\n", "a\nb\n", "a\nb\n", "a\nb\n")))).toEqual([]);
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
    expect(lines.map((line) => line.text).join("\n")).toMatchInlineSnapshot(`
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ greeting.txt @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
      old base rev-b1 | old tip rev-f1 | new base rev-b2 | new tip rev-f2
      @@@@@@@@ old tip 10,11 new tip 10,12 @@@@@@@@
        J
      +|K"
    `);
  });

  test("a conflict renders the feature ddiff", () => {
    const lines = diff({
      revNames: { b1: "rev-b1", b2: "rev-b2", f1: "rev-f1", f2: "rev-f2" },
      fileNames: Diamond.singleton("greeting.txt"),
      headerFileName: "greeting.txt",
      context: 1,
      linesRequiredToSeparateDdiffHunks: 3,
      contents: diamond("a\nb\nc\n", "a\nB\nc\n", "a\nx\nc\n", "a\ny\nc\n"),
      output: "Ascii",
    });
    expect(lines.map((line) => line.text).join("\n")).toMatchInlineSnapshot(`
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ greeting.txt @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
      old base rev-b1 | old tip rev-f1 | new base rev-b2 | new tip rev-f2
      @@@@@@@@ Conflicting changes: the reviewed diff compared to the current diff @@@@@@@@
      @@@@@@@@ -- old base 1,5 old tip 1,5 @@@@@@@@
      @@@@@@@@ ++ new base 1,5 new tip 1,5 @@@@@@@@
          a
      ---|b
      --+|x
      ++-|B
      +++|y
          c"
    `);
  });

  const structured = (contents: Diamond.Diamond<string>): readonly DiffAlgo.Line[] =>
    diff({
      revNames: { b1: "rev-b1", b2: "rev-b2", f1: "rev-f1", f2: "rev-f2" },
      fileNames: Diamond.singleton("file.txt"),
      headerFileName: "file.txt",
      context: 1,
      linesRequiredToSeparateDdiffHunks: 3,
      contents,
      output: "Ascii",
    });

  test("a diff extension places every line in its versions", () => {
    expect(structured(diamond("a\nb\n", "a\nb\n", "a\nx\nb\n", "a\ny\nb\n"))).toStrictEqual([
      { text: `${"@".repeat(37)} file.txt ${"@".repeat(37)}`, kind: undefined, provenance: {} },
      {
        text: "old base rev-b1 | old tip rev-f1 | new base rev-b2 | new tip rev-f2",
        kind: undefined,
        provenance: {},
      },
      { text: "@@@@@@@@ old tip 1,4 new tip 1,4 @@@@@@@@", kind: undefined, provenance: { f1: 1, f2: 1 } },
      { text: "  a", kind: "same", provenance: { f1: 1, f2: 1 } },
      { text: "-|x", kind: "prev", provenance: { f1: 2 } },
      { text: "+|y", kind: "next", provenance: { f2: 2 } },
      { text: "  b", kind: "same", provenance: { f1: 3, f2: 3 } },
    ]);
  });

  test("ddiff lines merge the provenance of the inner diffs they display", () => {
    // A conflict's feature ddiff, annotated: outer-same lines place their
    // content in all the versions both inner diffs cover, and outer-only
    // lines keep just their own side's.
    const annotate = (line: DiffAlgo.Line): string => {
      const at = Diamond.nodes
        .filter((node) => line.provenance[node] !== undefined)
        .map((node) => `${node}:${line.provenance[node]}`)
        .join(" ");
      return `${`${line.kind ?? ""} ${at}`.trim().padEnd(26)}|${line.text}`;
    };
    const lines = structured(diamond("a\nb\nc\n", "a\nB\nc\n", "a\nx\nc\n", "a\ny\nc\n"));
    expect(lines.map(annotate).join("\n")).toMatchInlineSnapshot(`
      "                          |@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ file.txt @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
                                |old base rev-b1 | old tip rev-f1 | new base rev-b2 | new tip rev-f2
                                |@@@@@@@@ Conflicting changes: the reviewed diff compared to the current diff @@@@@@@@
      b1:1 b2:1 f1:1 f2:1       |@@@@@@@@ -- old base 1,5 old tip 1,5 @@@@@@@@
      b1:1 b2:1 f1:1 f2:1       |@@@@@@@@ ++ new base 1,5 new tip 1,5 @@@@@@@@
      same b1:1 b2:1 f1:1 f2:1  |    a
      prev b1:2                 |---|b
      next f1:2                 |--+|x
      prev b2:2                 |++-|B
      next f2:2                 |+++|y
      same b1:3 b2:3 f1:3 f2:3  |    c"
    `);
  });
});

import { describe, expect, it } from "vitest";
import { MoveId } from "../patience-diff/move-id.js";
import { MoveKind } from "../patience-diff/move-kind.js";
import { ansiOutput } from "./ansi-output.js";
import { asciiOutput } from "./ascii-output.js";
import * as Format from "./format.js";
import * as PatdiffCore from "./patdiff-core.js";
import * as SideBySide from "./side-by-side.js";

const rules = Format.Rules.defaultRules;

describe("SideBySide.hunksToLines", () => {
  it("returns an empty array of hunks for empty input", () => {
    expect(SideBySide.hunksToLines([])).toEqual([]);
  });

  it("turns a simple replace into one Same and one Replace-derived row", () => {
    const hunks = PatdiffCore.withoutUnix.refineStructured({
      produceUnifiedLines: false,
      keepWs: false,
      splitLongLines: false,
      interleave: true,
      wordBigEnough: PatdiffCore.defaultWordBigEnough,
      hunks: PatdiffCore.withoutUnix.diff({
        context: 1,
        lineBigEnough: PatdiffCore.defaultLineBigEnough,
        keepWs: false,
        findMoves: false,
        prev: ["alpha", "beta", "gamma"],
        next: ["alpha", "BETA", "gamma"],
      }),
    });
    const rows = SideBySide.hunksToLines(hunks);
    expect(rows.length).toBeGreaterThan(0);
    // The replace should yield at least one row whose kind is Same (the unchanged
    // context line) and one Prev/Next/Same for the changed line.
    const allKinds = rows.flat().map((r) => r.kind);
    expect(allKinds).toContain("Same");
  });

  it("throws when a move's next side has no recorded prev side", () => {
    // A next-side move whose prev side never appears is a bookkeeping bug in
    // the hunks handed to us; the back-patch must not silently skip it.
    const hunks = [
      {
        prevStart: 1,
        prevSize: 0,
        nextStart: 1,
        nextSize: 1,
        ranges: [
          {
            kind: "next" as const,
            moveKind: MoveKind.move(MoveId.zero),
            contents: [[["Same", "moved line"] as const]],
          },
        ],
      },
    ];
    expect(() => SideBySide.hunksToLines(hunks)).toThrow(/no prev start recorded for move 0/);
  });
});

describe("SideBySide.build", () => {
  it("returns no blocks for identical inputs", () => {
    const hunks = PatdiffCore.withoutUnix.refineStructured({
      produceUnifiedLines: false,
      keepWs: false,
      splitLongLines: false,
      interleave: true,
      wordBigEnough: PatdiffCore.defaultWordBigEnough,
      hunks: PatdiffCore.withoutUnix.diff({
        context: 1,
        lineBigEnough: PatdiffCore.defaultLineBigEnough,
        keepWs: false,
        findMoves: false,
        prev: ["a", "b"],
        next: ["a", "b"],
      }),
    });
    const blocks = SideBySide.build({
      rules,
      wrapOrTruncate: "wrap",
      output: "Ansi",
      outputImpl: ansiOutput,
      hunks,
    });
    expect(blocks).toEqual([]);
  });

  it("produces left/right pairs of strings for a small diff", () => {
    const hunks = PatdiffCore.withoutUnix.refineStructured({
      produceUnifiedLines: false,
      keepWs: false,
      splitLongLines: false,
      interleave: true,
      wordBigEnough: PatdiffCore.defaultWordBigEnough,
      hunks: PatdiffCore.withoutUnix.diff({
        context: 1,
        lineBigEnough: PatdiffCore.defaultLineBigEnough,
        keepWs: false,
        findMoves: false,
        prev: ["hello", "world"],
        next: ["hello", "WORLD"],
      }),
    });
    const blocks = SideBySide.build({
      rules,
      wrapOrTruncate: "wrap",
      output: "Ascii",
      outputImpl: asciiOutput,
      hunks,
    });
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      for (const pair of block) {
        expect(pair).toHaveLength(2);
        expect(typeof pair[0]).toBe("string");
        expect(typeof pair[1]).toBe("string");
      }
    }
  });
});

describe("SideBySide.outputToString", () => {
  it("includes the file names in the header", () => {
    const hunks = PatdiffCore.withoutUnix.refineStructured({
      produceUnifiedLines: false,
      keepWs: false,
      splitLongLines: false,
      interleave: true,
      wordBigEnough: PatdiffCore.defaultWordBigEnough,
      hunks: PatdiffCore.withoutUnix.diff({
        context: 1,
        lineBigEnough: PatdiffCore.defaultLineBigEnough,
        keepWs: false,
        findMoves: false,
        prev: ["hello", "world"],
        next: ["hello", "WORLD"],
      }),
    });
    const out = SideBySide.outputToString({
      fileNames: [
        { kind: "Fake", name: "a.txt" },
        { kind: "Fake", name: "b.txt" },
      ],
      rules,
      wrapOrTruncate: "wrap",
      output: "Ascii",
      outputImpl: asciiOutput,
      hunks,
    });
    expect(out).toContain("a.txt");
    expect(out).toContain("b.txt");
    expect(out).toContain("|"); // ASCII divider
  });
});

/** Property tests for [patdiff_core], translated from OCaml's [test_patdiff_core.ml].
 *
 *  Two properties:
 *
 *  1. Round-trip recovery: after [diff] with infinite context, reassembling [prev_only]
 *     and [next_only] ranges from each hunk reproduces the original inputs.
 *
 *  2. Refinement preserves all content: after [refineStructured], the concatenated
 *     prev / next text reconstructed from the structured hunks equals the original
 *     prev / next text. (The OCaml description "set of changes is the same" is enforced
 *     here by checking that every original character survives refinement.) */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { Range } from "../patience-diff/range.js";
import { defaultWordBigEnough, withoutUnix } from "./patdiff-core.js";
import type { StructuredLine } from "./patdiff-core-types.js";

// 200 runs keeps each property under a couple seconds; OCaml's defaults are 1000 (or 50
// for the heavy refinement property).
const NUM_RUNS = 200;

type Action =
  | { readonly kind: "move"; readonly start: number; readonly length: number; readonly to: number }
  | { readonly kind: "delete"; readonly start: number; readonly length: number }
  | { readonly kind: "insert"; readonly start: number; readonly contents: string };

const applyAction = (s: string, action: Action): string => {
  switch (action.kind) {
    case "move": {
      const { start, length, to } = action;
      const prefix = s.slice(0, start);
      const suffix = s.slice(start + length);
      const toMove = s.slice(start, start + length);
      const beforeInsert = prefix + suffix;
      return beforeInsert.slice(0, to) + toMove + beforeInsert.slice(to);
    }
    case "delete":
      return s.slice(0, action.start) + s.slice(action.start + action.length);
    case "insert":
      return s.slice(0, action.start) + action.contents + s.slice(action.start);
  }
};

const alphaChar = (): fc.Arbitrary<string> =>
  fc.integer({ min: 0, max: 51 }).map((n) => String.fromCharCode(n < 26 ? 97 + n : 65 + (n - 26)));

const alphaNonempty = (): fc.Arbitrary<string> =>
  fc.array(alphaChar(), { minLength: 1, maxLength: 10 }).map((cs) => cs.join(""));

const actionGen = (strLength: number): fc.Arbitrary<Action> => {
  const idx = fc.integer({ min: 0, max: Math.max(0, strLength) });
  const len = fc.integer({ min: 0, max: Math.max(0, strLength) });
  return fc.oneof(
    fc.record({
      kind: fc.constant("move" as const),
      start: idx,
      length: len,
      to: idx,
    }),
    fc.record({
      kind: fc.constant("delete" as const),
      start: idx,
      length: len,
    }),
    fc.record({
      kind: fc.constant("insert" as const),
      start: idx,
      contents: fc.array(alphaChar(), { minLength: 1, maxLength: 10 }).map((cs) => cs.join("")),
    }),
  );
};

// Mirrors OCaml's [String.split_lines]: split on '\n' but drop a trailing empty
// component caused by a terminal newline. We don't get terminal newlines because we
// build [next_string] by [String.concat ~sep:"\n"] then apply Actions.
const splitLines = (s: string): string[] => {
  if (s.length === 0) return [];
  const parts = s.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
};

const stripBlankLines = (s: string): string => s.replace(/^\n+|\n+$/g, "");

describe("patdiff_core property tests", () => {
  it("ensure we can always recover the original content if there are moves", () => {
    const testCaseGen = fc.array(alphaNonempty(), { minLength: 50, maxLength: 50 }).chain((prev) => {
      const strLength = prev.reduce((s, w) => s + w.length, 0);
      return fc.array(actionGen(strLength), { minLength: 5, maxLength: 5 }).map((actions) => ({ prev, actions }));
    });

    fc.assert(
      fc.property(testCaseGen, ({ prev, actions }) => {
        const prevString = prev.join("\n");
        const nextString = actions.reduce(applyAction, prevString);
        const next = splitLines(nextString);
        const hunks = withoutUnix.diff({
          context: -1,
          lineBigEnough: 3,
          keepWs: false,
          findMoves: true,
          prev,
          next,
        });

        const recoverFromRanges = (
          rangesPerHunk: readonly (readonly Range<string>[])[],
          pickFromSame: (pair: readonly [string, string]) => string,
        ): string => {
          const out: string[] = [];
          for (const ranges of rangesPerHunk) {
            for (const range of ranges) {
              switch (range.kind) {
                case "same":
                  for (const pair of range.contents) out.push(pickFromSame(pair));
                  break;
                case "prev":
                case "next":
                  for (const line of range.contents) out.push(line);
                  break;
                case "replace":
                case "unified":
                  throw new Error(`unexpected range kind after prevOnly/nextOnly: ${range.kind}`);
              }
            }
          }
          return out.join("\n");
        };

        const recoverPrev = recoverFromRanges(
          hunks.map((h) => Range.prevOnly(h.ranges)),
          (pair) => pair[0],
        );
        const recoverNext = recoverFromRanges(
          hunks.map((h) => Range.nextOnly(h.ranges)),
          (pair) => pair[1],
        );

        expect(stripBlankLines(recoverPrev)).toBe(stripBlankLines(prevString));
        expect(stripBlankLines(recoverNext)).toBe(stripBlankLines(nextString));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("ensure that our refinement heuristic does not drop any changes", () => {
    // Refinement-heuristic stress: all lines differ and exactly one word is shared
    // between prev and next. Mirrors the OCaml generator.
    const generator = fc
      .record({
        linesPrev: fc.integer({ min: 200, max: 500 }),
        linesNext: fc.integer({ min: 200, max: 500 }),
      })
      .chain(({ linesPrev, linesNext }) =>
        fc.record({
          linesPrev: fc.constant(linesPrev),
          linesNext: fc.constant(linesNext),
          uniqueWordPrevLine: fc.integer({ min: 0, max: linesPrev - 1 }),
          uniqueWordNextLine: fc.integer({ min: 0, max: linesNext - 1 }),
        }),
      )
      .map(({ linesPrev, linesNext, uniqueWordPrevLine, uniqueWordNextLine }) => {
        const uniqueWord = "uniqueword";
        const prev: string[] = [];
        let prevWords = 0;
        for (let line = 0; line < linesPrev; line++) {
          const words: string[] = [];
          for (let w = 0; w < 5; w++) {
            if (line === uniqueWordPrevLine && w === 0) {
              words.push(uniqueWord);
            } else {
              words.push("prevword" + String(prevWords));
              prevWords++;
            }
          }
          prev.push(words.join(" "));
        }
        const next: string[] = [];
        let nextWords = 0;
        for (let line = 0; line < linesNext; line++) {
          const words: string[] = [];
          for (let w = 0; w < 5; w++) {
            if (line === uniqueWordNextLine && w === 0) {
              words.push(uniqueWord);
            } else {
              words.push("nextword" + String(nextWords));
              nextWords++;
            }
          }
          next.push(words.join(" "));
        }
        return { prev, next };
      });

    // OCaml uses ~trials:50 for this property — it is expensive (200-500 lines each).
    fc.assert(
      fc.property(generator, ({ prev, next }) => {
        const prevString = prev.join("\n");
        const nextString = next.join("\n");
        const diffed = withoutUnix.diff({
          context: -1,
          lineBigEnough: 3,
          keepWs: false,
          findMoves: true,
          prev,
          next,
        });
        const hunks = withoutUnix.refineStructured({
          produceUnifiedLines: false,
          keepWs: false,
          splitLongLines: false,
          interleave: false,
          wordBigEnough: defaultWordBigEnough,
          hunks: diffed,
        });

        const joinStructured = (line: readonly StructuredLine[]): string => line.map(([, s]) => s).join("");

        const recover = (
          pickFromSame: (
            pair: readonly [readonly StructuredLine[], readonly StructuredLine[]],
          ) => readonly StructuredLine[],
          selector: "prev" | "next",
        ): string => {
          const out: string[] = [];
          for (const hunk of hunks) {
            const filtered = selector === "prev" ? Range.prevOnly(hunk.ranges) : Range.nextOnly(hunk.ranges);
            for (const range of filtered) {
              switch (range.kind) {
                case "same":
                  for (const pair of range.contents) {
                    out.push(joinStructured(pickFromSame(pair)));
                  }
                  break;
                case "prev":
                case "next":
                  for (const line of range.contents) {
                    out.push(joinStructured(line));
                  }
                  break;
                case "replace":
                case "unified":
                  throw new Error(`unexpected range kind after prevOnly/nextOnly: ${range.kind}`);
              }
            }
          }
          return out.join("\n");
        };

        const recoverPrev = recover((pair) => pair[0], "prev");
        const recoverNext = recover((pair) => pair[1], "next");

        expect(stripBlankLines(recoverPrev)).toBe(stripBlankLines(prevString));
        expect(stripBlankLines(recoverNext)).toBe(stripBlankLines(nextString));
      }),
      // The OCaml runs only 50 trials of this heavy property; we match to keep runtime
      // reasonable (each trial generates 200-500 line input).
      { numRuns: 50 },
    );
  });
});

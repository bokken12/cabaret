import { describe, expect, it } from "vitest";

import { String as StringDiff } from "./patience-diff.js";

/** Builds inputs whose patience diff nests [depth] levels deep: each level's unique
 *  token [u_k] guards a gap holding the entire previous level, every common token of
 *  that inner level is duplicated in [a]'s tail so it only becomes unique (and
 *  matchable) once the diff descends into the gap, and fresh [pads] keep the
 *  unique-token ratio above the plain-diff cutoff. */
const buildNested = (depth: number): { a: string[]; b: string[] } => {
  let a: string[] = ["a0"];
  let b: string[] = ["b0"];
  let commonsInside = 0;
  let lastNew: string[] = [];
  for (let k = 1; k <= depth; k++) {
    const u = `u${k}`;
    const pads = Array.from({ length: Math.ceil(commonsInside / 9) }, (_, i) => `p${k}_${i}`);
    a = [...a, u, ...pads, ...lastNew];
    b = [...b, u, ...pads];
    lastNew = [u, ...pads];
    commonsInside += 1 + pads.length;
  }
  return { a, b };
};

/** Every common token occurs once in [b] and matches the first of its occurrences in
 *  [a]; later duplicates exist only to defeat outer-level uniqueness. */
const expectedMatches = (a: string[], b: string[]): Array<[number, number]> => {
  const firstInA = new Map<string, number>();
  a.forEach((token, i) => {
    if (!firstInA.has(token)) firstInA.set(token, i);
  });
  const expected: Array<[number, number]> = [];
  b.forEach((token, j) => {
    const i = firstInA.get(token);
    if (i !== undefined) expected.push([i, j]);
  });
  return expected;
};

describe("matches on deeply nested input", () => {
  it("finds the match hidden at every nesting level", () => {
    const { a, b } = buildNested(35);
    expect(StringDiff.matches(a, b)).toEqual(expectedMatches(a, b));
  });

  it("uses bounded call-stack depth", () => {
    // patdiff runs inside deep host call chains, so matches() must not consume JS
    // stack proportional to input nesting: an implementation recursing once per
    // level overflows here. Burn the stack down to a small reserve, then diff.
    const { a, b } = buildNested(80);
    const expected = expectedMatches(a, b);

    let reached = 0;
    const dive = (n: number, fn: (() => void) | undefined): void => {
      reached += 1;
      if (n === 0) {
        fn?.();
        return;
      }
      dive(n - 1, fn);
    };
    let result: Array<[number, number]> | undefined;
    const run = (): void => {
      result = StringDiff.matches(a, b);
    };

    // Warm the exact workload (JIT compilation happens on the stack, so nothing may
    // compile during the burned run below), and verify the result while at it.
    for (let w = 0; w < 2; w++) dive(10, run);
    expect(result).toEqual(expected);

    // Capacity is measured with the same function that later burns the stack, so the
    // frame sizes match.
    const stackCapacity = (): number => {
      reached = 0;
      try {
        dive(1_000_000_000, undefined);
      } catch {
        // RangeError: [reached] counts the frames that fit.
      }
      return reached;
    };
    stackCapacity();
    const capacity = stackCapacity();

    result = undefined;
    dive(capacity - 120, run);
    expect(result).toEqual(expected);
  });
});

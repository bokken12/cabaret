import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { Hunk } from "./hunk.js";
import { String as PatienceString } from "./patience-diff.js";

// 300 runs comfortably covers the small input space while keeping the test under a
// second. The deterministic LCG version this replaces did 200 fixed-seed runs.
const NUM_RUNS = 300;

describe("limit_infinite_context_hunk_to_context", () => {
  it("matches getHunks with finite context", () => {
    const lineArb = fc.string({ minLength: 0, maxLength: 20 });
    const linesArb = fc.array(lineArb, { minLength: 0, maxLength: 60 });

    fc.assert(
      fc.property(linesArb, linesArb, fc.integer({ min: 1, max: 10 }), (prev, next, context) => {
        const finiteHunks = PatienceString.getHunks({
          transform: (x: string) => x,
          context,
          prev,
          next,
        });
        const infiniteHunks = PatienceString.getHunks({
          transform: (x: string) => x,
          context: -1,
          prev,
          next,
        });
        expect(infiniteHunks.length).toBe(1);
        // Degenerate input — no diff at all (e.g. both inputs empty, or identical).
        // [limitInfiniteContextHunkToContext] drops a zero-ranges hunk, but [getHunks]
        // with finite context still returns the trivial empty hunk. This asymmetry is
        // outside the scope of the property under test.
        if (infiniteHunks[0]!.ranges.length === 0) return;
        const limited = Hunk.limitInfiniteContextHunkToContext(infiniteHunks[0]!, context);
        expect(limited).toEqual(finiteHunks);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

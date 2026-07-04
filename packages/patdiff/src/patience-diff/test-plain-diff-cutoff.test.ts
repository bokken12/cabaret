import { describe, expect, it } from "vitest";

import { iterMatches } from "./plain-diff.js";

describe("plain diff cutoff", () => {
  it("exercise cutoff code path", () => {
    const arr1 = [0, 1, 2, 3, 4, 5, 6, 42, 43, 7, 8, 9];
    const arr2 = [9, 8, 7, 42, 43, 6, 5, 4, 3, 2, 1, 0];

    const doDiff = (cutoff: number | undefined): string => {
      const out: string[] = [];
      iterMatches({
        a: arr1,
        b: arr2,
        hash: (x) => x,
        ...(cutoff !== undefined ? { cutoff } : {}),
        f: ([i, j]) => {
          if (arr1[i]! !== arr2[j]!) throw new Error("assertion failed");
          out.push(`(${arr1[i]} (${i} ${j}))`);
        },
      });
      return out.join("\n") + "\n";
    };

    expect(doDiff(undefined)).toMatchInlineSnapshot(`
      "(42 (7 3))
      (43 (8 4))
      "
    `);
    // Worse diff, but correct.
    expect(doDiff(3)).toMatchInlineSnapshot(`
      "(9 (11 0))
      "
    `);
  });
});

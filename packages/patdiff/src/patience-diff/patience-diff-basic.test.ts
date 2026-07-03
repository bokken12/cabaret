import { describe, expect, it } from "vitest";

import { make } from "./patience-diff.js";

const intOps = {
  compare: (a: number, b: number) => a - b,
  hash: (x: number) => x,
};
const Int = make(intOps);

describe("matches (basic)", () => {
  it("empty inputs", () => {
    expect(Int.matches([], [])).toEqual([]);
  });
  it("single element match", () => {
    expect(Int.matches([0], [0])).toEqual([[0, 0]]);
  });
  it("from OCaml test", () => {
    expect(Int.matches([0, 1, 1, 2], [3, 1, 4, 5])).toEqual([[1, 1]]);
  });
  it("monotone matches on permuted input", () => {
    const a = [0, 1, 2, 3, 4, 5, 6];
    const b = [2, 5, 6, 3, 0, 4, 1];
    const ms = Int.matches(a, b);
    const firsts = ms.map((m) => m[0]);
    const seconds = ms.map((m) => m[1]);
    for (let i = 1; i < firsts.length; i++) {
      expect(firsts[i]!).toBeGreaterThan(firsts[i - 1]!);
      expect(seconds[i]!).toBeGreaterThan(seconds[i - 1]!);
    }
  });
});

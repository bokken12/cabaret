import { describe, expect, it } from "vitest";
import {
  defaultContext,
  defaultLineBigEnough,
  defaultWordBigEnough,
  explode,
  removeWs,
  withoutUnix,
} from "./patdiff-core.js";

describe("PatdiffCore constants", () => {
  it("exposes the OCaml defaults", () => {
    expect(defaultContext).toBe(16);
    expect(defaultLineBigEnough).toBe(3);
    expect(defaultWordBigEnough).toBe(7);
  });
});

describe("PatdiffCore.removeWs", () => {
  it("returns the empty string for whitespace-only input", () => {
    expect(removeWs("   ")).toBe("");
    expect(removeWs("\t\n  ")).toBe("");
  });

  it("collapses internal whitespace into single spaces", () => {
    expect(removeWs("  hello   world  ")).toBe("hello world");
    expect(removeWs("a\tb")).toBe("a b");
    expect(removeWs("a  b   c")).toBe("a b c");
  });

  it("leaves words without whitespace alone", () => {
    expect(removeWs("hello")).toBe("hello");
  });
});

describe("PatdiffCore.explode", () => {
  it("returns an empty array for no lines", () => {
    expect(explode([], false)).toEqual([]);
  });

  it("tokenizes a simple single-line input", () => {
    const out = explode(["hello world"], true);
    // Expect at least one word token and a final newline.
    const kinds = out.map((t) => t.kind);
    expect(kinds).toContain("word");
    expect(kinds[kinds.length - 1]).toBe("newline");
  });
});

describe("PatdiffCore.withoutUnix.diff", () => {
  it("returns a single all-same hunk for identical input", () => {
    const prev = ["a", "b", "c"];
    const next = ["a", "b", "c"];
    const hunks = withoutUnix.diff({
      context: 3,
      lineBigEnough: defaultLineBigEnough,
      keepWs: false,
      findMoves: false,
      prev,
      next,
    });
    // With identical input we expect zero hunks or one hunk of only-same.
    if (hunks.length > 0) {
      for (const h of hunks) {
        for (const r of h.ranges) {
          expect(r.kind).toBe("same");
        }
      }
    }
  });

  it("detects a single replacement", () => {
    const prev = ["a", "b", "c"];
    const next = ["a", "B", "c"];
    const hunks = withoutUnix.diff({
      context: 3,
      lineBigEnough: defaultLineBigEnough,
      keepWs: false,
      findMoves: false,
      prev,
      next,
    });
    expect(hunks.length).toBeGreaterThan(0);
    const kinds = hunks.flatMap((h) => h.ranges.map((r) => r.kind));
    expect(kinds).toContain("replace");
  });
});

describe("PatdiffCore.withoutUnix.patdiff", () => {
  it("returns an empty string for identical inputs", () => {
    const result = withoutUnix.patdiff({
      prev: { name: "a.txt", text: "hello\nworld\n" },
      next: { name: "b.txt", text: "hello\nworld\n" },
      output: "Ascii",
      produceUnifiedLines: false,
    });
    expect(result).toBe("");
  });

  it("produces non-empty output for differing inputs", () => {
    const result = withoutUnix.patdiff({
      prev: { name: "a.txt", text: "hello\nworld\n" },
      next: { name: "b.txt", text: "hello\nthere\n" },
      output: "Ascii",
      produceUnifiedLines: false,
    });
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("PatdiffCore.withoutUnix.outputWidth", () => {
  it("returns the override when provided", () => {
    expect(withoutUnix.outputWidth({ widthOverride: 80 })).toBe(80);
  });

  it("returns a sensible default", () => {
    expect(withoutUnix.outputWidth()).toBeGreaterThan(0);
  });
});

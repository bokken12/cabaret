import { describe, expect, it } from "vitest";
import { containsOnlyWhitespace, isWhitespace, splitLines, strip } from "./string-util.js";

describe("isWhitespace", () => {
  it("recognises space/tab/newline/cr", () => {
    expect(isWhitespace(" ")).toBe(true);
    expect(isWhitespace("\t")).toBe(true);
    expect(isWhitespace("\n")).toBe(true);
    expect(isWhitespace("\r")).toBe(true);
  });

  it("rejects non-whitespace", () => {
    expect(isWhitespace("a")).toBe(false);
    expect(isWhitespace("\f")).toBe(false);
    expect(isWhitespace("\v")).toBe(false);
  });
});

describe("strip", () => {
  it("trims leading and trailing whitespace", () => {
    expect(strip("  hello  ")).toBe("hello");
    expect(strip("\t\nfoo\r\n")).toBe("foo");
  });

  it("leaves internal whitespace alone", () => {
    expect(strip("  a b c  ")).toBe("a b c");
  });

  it("empty / all-whitespace", () => {
    expect(strip("")).toBe("");
    expect(strip("   ")).toBe("");
  });
});

describe("splitLines", () => {
  it("splits simple lines", () => {
    expect(splitLines("a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  it("trailing newline does not produce empty entry", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
  });

  it("empty string returns empty array", () => {
    expect(splitLines("")).toEqual([]);
  });

  it("only newline returns one empty line", () => {
    expect(splitLines("\n")).toEqual([""]);
  });

  it("handles CRLF", () => {
    expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b"]);
  });

  it("preserves empty lines in middle", () => {
    expect(splitLines("a\n\nb")).toEqual(["a", "", "b"]);
  });
});

describe("containsOnlyWhitespace", () => {
  it("true for empty and whitespace-only", () => {
    expect(containsOnlyWhitespace("")).toBe(true);
    expect(containsOnlyWhitespace("  \t\n")).toBe(true);
  });

  it("false when any non-whitespace", () => {
    expect(containsOnlyWhitespace("  a  ")).toBe(false);
  });
});

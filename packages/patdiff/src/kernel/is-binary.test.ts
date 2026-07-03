import { describe, expect, it } from "vitest";
import * as IsBinary from "./is-binary.js";

describe("Is_binary.string", () => {
  it("ASCII text is not binary", () => {
    expect(IsBinary.string("hello world\nthis is\na text file\n")).toBe(false);
  });

  it("a null byte makes it binary", () => {
    expect(IsBinary.string("abc\0def")).toBe(true);
  });

  it("empty string is not binary", () => {
    expect(IsBinary.string("")).toBe(false);
  });

  it("only inspects the first 8000 bytes", () => {
    const s = "a".repeat(8000) + "\0extra";
    expect(IsBinary.string(s)).toBe(false);
  });
});

describe("Is_binary.array", () => {
  it("array of plain lines is not binary", () => {
    expect(IsBinary.array(["foo", "bar", "baz"])).toBe(false);
  });

  it("any line containing null makes it binary", () => {
    expect(IsBinary.array(["foo", "bar\0baz"])).toBe(true);
  });

  it("stops at 8000 bytes prefix", () => {
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) lines.push("x".repeat(1000));
    lines.push("late\0null");
    expect(IsBinary.array(lines)).toBe(false);
  });
});

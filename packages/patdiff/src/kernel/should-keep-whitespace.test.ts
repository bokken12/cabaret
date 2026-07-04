import { describe, expect, it } from "vitest";
import type { DiffInput } from "./diff-input.js";
import * as ShouldKeepWhitespace from "./should-keep-whitespace.js";

const mkInput = (name: string, text: string): DiffInput => ({ name, text });

describe("ShouldKeepWhitespace.forDiff", () => {
  it("py extension triggers keep", () => {
    const prev = mkInput("a.py", "x = 1\n");
    const next = mkInput("a.py", "x = 2\n");
    expect(ShouldKeepWhitespace.forDiff({ prev, next })).toBe(true);
  });

  it("only one side .py is enough", () => {
    const prev = mkInput("a.txt", "x");
    const next = mkInput("b.py", "y");
    expect(ShouldKeepWhitespace.forDiff({ prev, next })).toBe(true);
  });

  it("python shebang triggers keep", () => {
    const prev = mkInput("script", "#!/usr/bin/env python\nprint(1)\n");
    const next = mkInput("script", "#!/usr/bin/env python\nprint(2)\n");
    expect(ShouldKeepWhitespace.forDiff({ prev, next })).toBe(true);
  });

  it("non-python first line does not trigger keep", () => {
    const prev = mkInput("script", "#!/bin/bash\necho 1\n");
    const next = mkInput("script", "#!/bin/bash\necho 2\n");
    expect(ShouldKeepWhitespace.forDiff({ prev, next })).toBe(false);
  });

  it(".fs and family triggers keep", () => {
    for (const ext of [".fs", ".fsi", ".fsy", ".fsl", ".fsx"]) {
      const prev = mkInput(`a${ext}`, "");
      const next = mkInput(`b.txt`, "");
      expect(ShouldKeepWhitespace.forDiff({ prev, next })).toBe(true);
    }
  });

  it("plain text files do not trigger keep", () => {
    const prev = mkInput("a.txt", "foo\nbar\n");
    const next = mkInput("a.txt", "foo\nbaz\n");
    expect(ShouldKeepWhitespace.forDiff({ prev, next })).toBe(false);
  });

  it("forDiffArray works with empty lines", () => {
    expect(
      ShouldKeepWhitespace.forDiffArray({
        prev: ["a.py", []],
        next: ["b.py", []],
      }),
    ).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import * as Patdiff from "./patdiff.js";

describe("Patdiff: top-level module", () => {
  it("exports the major namespaces", () => {
    expect(Patdiff.CompareCore).toBeDefined();
    expect(Patdiff.Configuration).toBeDefined();
    expect(Patdiff.PatdiffCore).toBeDefined();
    expect(Patdiff.HtmlOutput).toBeDefined();
    expect(Patdiff.AnsiOutput).toBeDefined();
    expect(Patdiff.Format).toBeDefined();
    expect(Patdiff.Hunks).toBeDefined();
    expect(Patdiff.FileName).toBeDefined();
    expect(Patdiff.Output).toBeDefined();
    expect(Patdiff.DiffInput).toBeDefined();
    expect(Patdiff.Private).toBeDefined();
  });

  it("exposes Private.IsBinary and Private.ShouldKeepWhitespace", () => {
    expect(Patdiff.Private.IsBinary.string("hello")).toBe(false);
    expect(Patdiff.Private.IsBinary.string("a\x00b")).toBe(true);
  });

  it("CompareCore.withNodeIoCompare works end-to-end", () => {
    const res = Patdiff.CompareCore.withNodeIoCompare.diffStrings({
      config: Patdiff.Configuration.override(Patdiff.Configuration.defaultConfiguration, { output: "Ascii" }),
      prev: { name: "a", text: "hello\n" },
      next: { name: "b", text: "world\n" },
    });
    expect(res.kind).toBe("Different");
  });
});

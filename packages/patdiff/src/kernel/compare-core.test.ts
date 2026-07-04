import { describe, expect, it } from "vitest";
import * as CompareCore from "./compare-core.js";
import { defaultConfiguration, override } from "./configuration.js";

describe("CompareCore.withoutUnix.compareLines", () => {
  it("returns an all-Same Hunks result for identical inputs", () => {
    const res = CompareCore.withoutUnix.compareLines({
      config: defaultConfiguration,
      prev: ["alpha", "beta"],
      next: ["alpha", "beta"],
    });
    expect(res.kind).toBe("Hunks");
    if (res.kind === "Hunks") {
      // either zero hunks, or all-Same hunks
      for (const h of res.hunks) {
        for (const r of h.ranges) expect(r.kind).toBe("same");
      }
    }
  });

  it("returns refined Hunks for a small diff", () => {
    const res = CompareCore.withoutUnix.compareLines({
      config: defaultConfiguration,
      prev: ["hello", "world"],
      next: ["hello", "WORLD"],
    });
    expect(res.kind).toBe("Hunks");
    if (res.kind === "Hunks") {
      expect(res.hunks.length).toBeGreaterThan(0);
    }
  });

  it("returns StructuredHunks when sideBySide is configured", () => {
    const config = override(defaultConfiguration, { sideBySide: "wrap" });
    const res = CompareCore.withoutUnix.compareLines({
      config,
      prev: ["hello", "world"],
      next: ["hello", "WORLD"],
    });
    expect(res.kind).toBe("StructuredHunks");
  });
});

describe("CompareCore.withoutUnix.diffStrings", () => {
  it("returns Same for identical inputs", () => {
    const res = CompareCore.withoutUnix.diffStrings({
      config: defaultConfiguration,
      prev: { name: "a.txt", text: "hello\nworld\n" },
      next: { name: "b.txt", text: "hello\nworld\n" },
    });
    expect(res.kind).toBe("Same");
  });

  it("returns Different with a non-empty string for differing inputs", () => {
    const res = CompareCore.withoutUnix.diffStrings({
      config: override(defaultConfiguration, { output: "Ascii" }),
      prev: { name: "a.txt", text: "hello\nworld\n" },
      next: { name: "b.txt", text: "hello\nthere\n" },
    });
    expect(res.kind).toBe("Different");
    if (res.kind === "Different") {
      expect(res.value.length).toBeGreaterThan(0);
    }
  });

  it("reports binary-different for non-text inputs", () => {
    // A NUL byte triggers the binary heuristic.
    const prev = { name: "a.bin", text: "abc\x00def" };
    const next = { name: "b.bin", text: "xyz\x00qrs" };
    const res = CompareCore.withoutUnix.diffStrings({
      config: defaultConfiguration,
      prev,
      next,
    });
    expect(res.kind).toBe("Different");
    if (res.kind === "Different") {
      expect(res.value).toContain("differ");
    }
  });

  it("returns Same for two identical binary inputs", () => {
    const same = { text: "abc\x00def", name: "a.bin" };
    const res = CompareCore.withoutUnix.diffStrings({
      config: defaultConfiguration,
      prev: same,
      next: { ...same, name: "b.bin" },
    });
    expect(res.kind).toBe("Same");
  });

  it("returns a side-by-side string when sideBySide is configured", () => {
    const config = override(defaultConfiguration, {
      sideBySide: "wrap",
      output: "Ascii",
    });
    const res = CompareCore.withoutUnix.diffStrings({
      config,
      prev: { name: "a.txt", text: "hello\nworld\n" },
      next: { name: "b.txt", text: "hello\nthere\n" },
    });
    expect(res.kind).toBe("Different");
    if (res.kind === "Different") {
      // Side-by-side output contains the divider character.
      expect(res.value).toContain("|");
    }
  });
});

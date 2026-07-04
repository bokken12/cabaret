import { describe, expect, it } from "vitest";
import { withNodeIo } from "./patdiff-core.js";

describe("Patdiff_core (Node I/O)", () => {
  it("outputWidth returns a sensible number", () => {
    const w = withNodeIo.outputWidth({});
    expect(w).toBeGreaterThan(0);
  });

  it("respects widthOverride", () => {
    const w = withNodeIo.outputWidth({ widthOverride: 30 });
    expect(w).toBeLessThanOrEqual(30);
  });
});

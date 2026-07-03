import { describe, expect, it } from "vitest";
import * as Configuration from "./configuration.js";

describe("Configuration", () => {
  it("default has Ansi output and Diff location_style", () => {
    expect(Configuration.defaultConfiguration.output).toBe("Ansi");
    expect(Configuration.defaultConfiguration.locationStyle).toBe("Diff");
    expect(Configuration.defaultConfiguration.context).toBe(Configuration.defaultContext);
  });

  it("override changes a single field", () => {
    const t = Configuration.override(Configuration.defaultConfiguration, {
      context: 7,
    });
    expect(t.context).toBe(7);
    // other fields unchanged
    expect(t.output).toBe("Ansi");
    expect(t.locationStyle).toBe("Diff");
  });

  it("override to Ascii output forces unrefined to true", () => {
    const t = Configuration.override(Configuration.defaultConfiguration, {
      output: "Ascii",
    });
    expect(t.output).toBe("Ascii");
    expect(t.unrefined).toBe(true);
  });

  it("override roundtrips through identity", () => {
    const t = Configuration.override(Configuration.defaultConfiguration, {});
    expect(t).toEqual(Configuration.defaultConfiguration);
  });

  it("createExn invariant rejects non-positive line_big_enough", () => {
    expect(() =>
      Configuration.createExn({
        ...Configuration.defaultConfiguration,
        lineBigEnough: 0,
      }),
    ).toThrow();
  });

  it("createExn invariant rejects non-positive word_big_enough", () => {
    expect(() =>
      Configuration.createExn({
        ...Configuration.defaultConfiguration,
        wordBigEnough: -1,
      }),
    ).toThrow();
  });

  it("createExn invariant requires unrefined when Ascii", () => {
    expect(() =>
      Configuration.createExn({
        ...Configuration.defaultConfiguration,
        output: "Ascii",
        unrefined: false,
      }),
    ).toThrow();
  });

  it("createExn accepts Ascii with unrefined: true", () => {
    const c = Configuration.createExn({
      ...Configuration.defaultConfiguration,
      output: "Ascii",
      unrefined: true,
    });
    expect(c.output).toBe("Ascii");
    expect(c.unrefined).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { Percent } from "../shared/percent.js";
import * as FloatTolerance from "./float-tolerance.js";

describe("FloatTolerance.createStringWithFloats", () => {
  it("trailing .", () => {
    const r = FloatTolerance.createStringWithFloats("(foo 12.)");
    expect(r).toEqual({ floats: [12], withoutFloats: "(foo )" });
  });

  it("scientific notation parses", () => {
    const inputs = [
      "(foo -12345678910.11)",
      "(foo -1.234567891011e10)",
      "(foo -1.234567891011e+10)",
      "(foo -1.234567891011E10)",
      "(foo -1.234567891011E+10)",
      "(foo -123456789101.1e-1)",
      "(foo -1234567891011.e-2)",
      "(foo -1234567891011e-2)",
    ];
    for (const s of inputs) {
      const r = FloatTolerance.createStringWithFloats(s);
      expect(r.withoutFloats).toBe("(foo )");
      expect(r.floats).toHaveLength(1);
      expect(r.floats[0]).toBeCloseTo(-12345678910.11, 4);
    }
  });

  it("multiple floats", () => {
    const r = FloatTolerance.createStringWithFloats("(dynamic (Ok ((price_range (-18.8305 39.1095)))))");
    expect(r.withoutFloats).toBe("(dynamic (Ok ((price_range ( )))))");
    expect(r.floats).toEqual([-18.8305, 39.1095]);
  });

  it("time-like values split into multiple floats", () => {
    const r = FloatTolerance.createStringWithFloats(
      "(primary_exchange_core_session (09:30:00.000000 16:00:00.000000))",
    );
    expect(r.withoutFloats).toBe("(primary_exchange_core_session (:: ::))");
    expect(r.floats).toEqual([9, 30, 0, 16, 0, 0]);
  });
});

describe("FloatTolerance.closeEnough", () => {
  it("exact match returns true", () => {
    const eq = FloatTolerance.closeEnough(Percent.ofPercentage(1));
    const a = FloatTolerance.createStringWithFloats("hello 1.0 world");
    const b = FloatTolerance.createStringWithFloats("hello 1.0 world");
    expect(eq(a, b)).toBe(true);
  });

  it("within tolerance returns true", () => {
    const eq = FloatTolerance.closeEnough(Percent.ofPercentage(10));
    const a = FloatTolerance.createStringWithFloats("(x 100.0)");
    const b = FloatTolerance.createStringWithFloats("(x 105.0)");
    expect(eq(a, b)).toBe(true);
  });

  it("outside tolerance returns false", () => {
    const eq = FloatTolerance.closeEnough(Percent.ofPercentage(1));
    const a = FloatTolerance.createStringWithFloats("(x 100.0)");
    const b = FloatTolerance.createStringWithFloats("(x 200.0)");
    expect(eq(a, b)).toBe(false);
  });

  it("different shape returns false", () => {
    const eq = FloatTolerance.closeEnough(Percent.ofPercentage(50));
    const a = FloatTolerance.createStringWithFloats("(x 1.0)");
    const b = FloatTolerance.createStringWithFloats("(y 1.0)");
    expect(eq(a, b)).toBe(false);
  });
});

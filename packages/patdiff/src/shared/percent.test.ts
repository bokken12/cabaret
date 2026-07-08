import { describe, expect, it } from "vitest";
import { Percent } from "./percent.js";

describe("Percent constructors / accessors", () => {
  it("ofPercentage / toPercentage", () => {
    const p = Percent.ofPercentage(50);
    expect(Percent.toMult(p)).toBe(0.5);
    expect(Percent.toPercentage(p)).toBe(50);
  });

  it("ofMult / toMult", () => {
    const p = Percent.ofMult(0.25);
    expect(Percent.toMult(p)).toBe(0.25);
    expect(Percent.toPercentage(p)).toBe(25);
  });

  it("ofBp / toBp", () => {
    const p = Percent.ofBp(50);
    expect(Percent.toMult(p)).toBe(0.005);
    expect(Percent.toBp(p)).toBe(50);
  });
});

describe("Percent.toString", () => {
  it("prints as % for fractions under 1x", () => {
    expect(Percent.toString(Percent.ofPercentage(50))).toBe("50%");
    expect(Percent.toString(Percent.ofPercentage(25))).toBe("25%");
  });

  it("prints as x for >= 1.0", () => {
    expect(Percent.toString(Percent.ofMult(1))).toBe("1x");
    expect(Percent.toString(Percent.ofMult(2.5))).toBe("2.5x");
  });

  it("prints as bp for very small values", () => {
    expect(Percent.toString(Percent.ofBp(50))).toBe("50bp");
  });

  it("zero", () => {
    expect(Percent.toString(Percent.ofMult(0))).toBe("0x");
  });
});

describe("Percent.parse", () => {
  it("parses %", () => {
    expect(Percent.toMult(Percent.parse("50%"))).toBe(0.5);
  });

  it("parses x", () => {
    expect(Percent.toMult(Percent.parse("2.5x"))).toBe(2.5);
  });

  it("parses bp", () => {
    expect(Percent.toMult(Percent.parse("50bp"))).toBe(0.005);
  });

  it("trims whitespace", () => {
    expect(Percent.toMult(Percent.parse("  50%  "))).toBe(0.5);
  });

  it("throws on no suffix", () => {
    expect(() => Percent.parse("50")).toThrow();
  });

  it("throws on bad number", () => {
    expect(() => Percent.parse("abc%")).toThrow();
  });

  it("throws on a bare unit suffix", () => {
    expect(() => Percent.parse("x")).toThrow();
    expect(() => Percent.parse("%")).toThrow();
    expect(() => Percent.parse("bp")).toThrow();
    expect(() => Percent.parse(" x ")).toThrow();
  });
});

describe("Percent round-trip", () => {
  it("parse(toString(p)) === p", () => {
    const samples = [Percent.ofPercentage(50), Percent.ofPercentage(25), Percent.ofMult(2), Percent.ofBp(50)];
    for (const p of samples) {
      const round = Percent.parse(Percent.toString(p));
      expect(Percent.toMult(round)).toBeCloseTo(Percent.toMult(p));
    }
  });
});

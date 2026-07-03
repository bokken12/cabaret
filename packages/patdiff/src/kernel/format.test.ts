import { describe, expect, it } from "vitest";
import * as Attr from "../ansi-text/attr.js";
import * as Color from "../ansi-text/color.js";
import * as Format from "./format.js";

describe("Format.Rule", () => {
  it("blank is empty styles and blank pre/suf", () => {
    expect(Format.Rule.blank).toEqual({
      pre: Format.Affix.blank,
      suf: Format.Affix.blank,
      styles: [],
    });
  });

  it("create with pre", () => {
    const r = Format.Rule.create([Attr.Bold], {
      pre: Format.Affix.create("X", [Attr.Italic]),
    });
    expect(r.pre.text).toBe("X");
    expect(r.pre.styles).toEqual([Attr.Italic]);
    expect(r.suf).toEqual(Format.Affix.blank);
    expect(r.styles).toEqual([Attr.Bold]);
  });

  it("unstyledPrefix", () => {
    const r = Format.Rule.unstyledPrefix("> ");
    expect(r.pre.text).toBe("> ");
    expect(r.pre.styles).toEqual([]);
    expect(r.styles).toEqual([]);
  });

  it("stripStyles removes all styles", () => {
    const r = Format.Rule.create([Attr.Bold, Attr.Fg(Color.red)], {
      pre: Format.Affix.create("p", [Attr.Italic]),
      suf: Format.Affix.create("s", [Attr.Underline]),
    });
    const stripped = Format.Rule.stripStyles(r);
    expect(stripped.styles).toEqual([]);
    expect(stripped.pre.styles).toEqual([]);
    expect(stripped.suf.styles).toEqual([]);
    expect(stripped.pre.text).toBe("p");
    expect(stripped.suf.text).toBe("s");
  });

  it("stripPrefix clears pre", () => {
    const r = Format.Rule.create([], {
      pre: Format.Affix.create("p", [Attr.Italic]),
    });
    expect(Format.Rule.stripPrefix(r).pre).toEqual(Format.Affix.blank);
  });

  it("usePrefixTextFrom takes other's pre.text only", () => {
    const r = Format.Rule.create([], {
      pre: Format.Affix.create("orig", [Attr.Italic]),
    });
    const other = Format.Rule.create([], { pre: Format.Affix.create("new") });
    const used = Format.Rule.usePrefixTextFrom(r, other);
    expect(used.pre.text).toBe("new");
    expect(used.pre.styles).toEqual([Attr.Italic]);
  });
});

describe("Format.Rules", () => {
  it("defaultRules has 18 fields including lineSame", () => {
    expect(Format.Rules.defaultRules.lineSame.pre.text).toBe("  ");
    expect(Format.Rules.defaultRules.linePrev.pre.text).toBe("-|");
    expect(Format.Rules.defaultRules.lineNext.pre.text).toBe("+|");
    expect(Format.Rules.defaultRules.lineUnified.pre.text).toBe("!|");
  });

  it("default color palette uses standard colors", () => {
    const p = Format.ColorPalette.defaultPalette;
    expect(p.added).toEqual(Color.Standard("Green"));
    expect(p.removed).toEqual(Color.Standard("Red"));
    expect(p.movedFromPrev).toEqual(Color.Standard("Magenta"));
    expect(p.movedToNext).toEqual(Color.Standard("Cyan"));
  });

  it("stripStyles strips every rule", () => {
    const stripped = Format.Rules.stripStyles(Format.Rules.defaultRules);
    expect(stripped.linePrev.styles).toEqual([]);
    expect(stripped.lineNext.styles).toEqual([]);
    expect(stripped.linePrev.pre.text).toBe("-|");
  });
});

describe("Format.LocationStyle", () => {
  it("toString/ofString round-trip", () => {
    for (const s of Format.LocationStyle.all) {
      const str = Format.LocationStyle.toString(s);
      expect(Format.LocationStyle.ofString(str)).toBe(s);
    }
  });

  it("omake start formatter", () => {
    expect(
      Format.LocationStyle.omakeStyleErrorMessageStart({
        file: "x.ml",
        line: 7,
      }),
    ).toBe(`File "x.ml", line 7, characters 0-1:`);
  });

  it("sprint Diff prints line ranges", () => {
    const out = Format.LocationStyle.sprint({
      style: "Diff",
      hunk: {
        prevStart: 1,
        prevSize: 2,
        nextStart: 3,
        nextSize: 4,
        ranges: [],
      },
      prevFilename: "f",
      rule: (s) => `[${s}]`,
    });
    expect(out).toBe("[-1,2 +3,4]");
  });

  it("sprint Separator", () => {
    const out = Format.LocationStyle.sprint({
      style: "Separator",
      hunk: {
        prevStart: 1,
        prevSize: 0,
        nextStart: 1,
        nextSize: 0,
        ranges: [],
      },
      prevFilename: "f",
      rule: (s) => s,
    });
    expect(out).toBe("=== DIFF HUNK ===");
  });
});

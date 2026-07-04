import { describe, expect, it } from "vitest";
import * as Attr from "../ansi-text/attr.js";
import * as Color from "../ansi-text/color.js";
import type { Hunk } from "../patience-diff/hunk.js";
import * as AnsiOutput from "./ansi-output.js";
import * as AsciiOutput from "./ascii-output.js";
import * as Configuration from "./configuration.js";
import * as FileName from "./file-name.js";
import * as Format from "./format.js";
import * as HtmlOutput from "./html-output.js";

const sampleHunk: Hunk<string> = {
  prevStart: 1,
  prevSize: 2,
  nextStart: 1,
  nextSize: 2,
  ranges: [
    {
      kind: "same",
      contents: [
        ["a", "a"],
        ["b", "b"],
      ],
    },
  ],
};

describe("AnsiOutput.applyRule", () => {
  it("plain rule with no styles passes text through with affixes", () => {
    const rule = Format.Rule.create([], {
      pre: Format.Affix.create("> "),
    });
    expect(AnsiOutput.applyRule("hello", { rule, refined: false })).toBe("> hello");
  });

  it("rule with styles wraps body in ANSI escape codes", () => {
    const rule = Format.Rule.create([Attr.Fg(Color.red)]);
    const out = AnsiOutput.applyRule("x", { rule, refined: false });
    expect(out).toContain("\x1b[");
    expect(out).toContain("x");
  });
});

describe("AsciiOutput", () => {
  it("strips styles from the rule", () => {
    const rule = Format.Rule.create([Attr.Fg(Color.red)], {
      pre: Format.Affix.create(">", [Attr.Bold]),
    });
    const out = AsciiOutput.applyRule("x", { rule, refined: false });
    expect(out).toBe(">x");
    expect(out).not.toContain("\x1b[");
  });
});

describe("HtmlOutput", () => {
  it("escapes html special characters in body", () => {
    const rule = Format.Rule.blank;
    const out = HtmlOutput.makeApplyRule("<a>&b", { rule, refined: false });
    expect(out).toBe("&lt;a&gt;&amp;b");
  });

  it("withoutMtime prints a basic html block", () => {
    const lines: string[] = [];
    HtmlOutput.withoutMtime.print({
      printGlobalHeader: false,
      fileNames: [FileName.fake("p"), FileName.fake("n")],
      rules: Configuration.defaultConfiguration.rules,
      print: (s) => lines.push(s),
      locationStyle: "None",
      hunks: [sampleHunk],
    });
    expect(lines[0]).toContain("<pre");
    expect(lines[lines.length - 1]).toBe("</pre>");
  });
});

import { parseFilePath, parseRefName } from "cabaret-core";
import { expect, test } from "vitest";
import { type Doc, docText, foldedText, type Line, layout, section, span, targetAt } from "../index.js";

const change = { kind: "change", change: parseRefName("widgets") } as const;
const location = { kind: "location", file: parseFilePath("api.ts"), line: 7 } as const;

const doc: Doc = {
  lines: [
    { spans: [span("| "), span("widgets", { target: change }), span(" |")] },
    { spans: [] },
    { spans: [span("plain text")] },
    { spans: [span("const x = 1;", { target: location, tier: "jump" })] },
  ],
  folds: [],
  errors: [],
};

test("targetAt resolves a line to its target of either tier, and a plain line to nothing", () => {
  expect(targetAt(doc, 0)).toEqual(change);
  expect(targetAt(doc, 1)).toBeUndefined();
  expect(targetAt(doc, 2)).toBeUndefined();
  expect(targetAt(doc, 3)).toEqual(location);
  expect(targetAt(doc, 9)).toBeUndefined();
});

test("docText joins spans and lines", () => {
  expect(docText(doc)).toBe("| widgets |\n\nplain text\nconst x = 1;");
});

test("span defaults a target's tier to link and a plain span to none", () => {
  expect(span("widgets", { target: change })).toEqual({
    text: "widgets",
    style: undefined,
    target: change,
    tier: "link",
  });
  expect(span("plain").tier).toBeUndefined();
});

test("span refuses multi-line text", () => {
  expect(() => span("two\nlines")).toThrow('span text must be a single line: "two\\nlines"');
});

test("span refuses a tier without a target", () => {
  expect(() => span("plain", { tier: "jump" })).toThrow("a span's tier qualifies its target; it cannot stand alone");
});

const line = (text: string): Line => ({ spans: [span(text)] });

test("layout flattens nested sections and derives their folds", () => {
  const laid = layout([
    line("title"),
    section(line("outer:"), [line("  a"), section(line("  inner:"), [line("    b")], { folded: true }), line("  c")]),
    line("tail"),
  ]);
  expect(docText(laid)).toBe("title\nouter:\n  a\n  inner:\n    b\n  c\ntail");
  // Each fold spans its whole section, the heading through the last line of
  // the deepest descendant, ordered by start line.
  expect(laid.folds).toEqual([
    { start: 1, end: 5, folded: false },
    { start: 3, end: 4, folded: true },
  ]);
  // Folded text keeps a folded section's heading and drops its body.
  expect(foldedText(laid)).toBe("title\nouter:\n  a\n  inner:\n  c\ntail");
  expect(foldedText(layout([section(line("outer:"), [line("  a")], { folded: true })]))).toBe("outer:");
});

test("layout of bare lines has nothing to fold", () => {
  expect(layout([line("a"), line("b")])).toEqual({ lines: [line("a"), line("b")], folds: [], errors: [] });
});

test("section refuses an empty body", () => {
  expect(() => section(line("bare:"), [])).toThrow("a section's body cannot be empty");
});

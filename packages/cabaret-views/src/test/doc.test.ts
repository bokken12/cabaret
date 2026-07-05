import { parseRefName } from "cabaret-core";
import { expect, test } from "vitest";
import { type Doc, docText, span, targetAt } from "../index.js";

const change = { kind: "change", change: parseRefName("widgets") } as const;

const doc: Doc = {
  lines: [
    { spans: [span("| "), span("widgets", { target: change }), span(" |")] },
    { spans: [] },
    { spans: [span("plain text")] },
  ],
};

test("targetAt resolves a line to its target, and a plain line to nothing", () => {
  expect(targetAt(doc, 0)).toEqual(change);
  expect(targetAt(doc, 1)).toBeUndefined();
  expect(targetAt(doc, 2)).toBeUndefined();
  expect(targetAt(doc, 9)).toBeUndefined();
});

test("docText joins spans and lines", () => {
  expect(docText(doc)).toBe("| widgets |\n\nplain text");
});

test("span refuses multi-line text", () => {
  expect(() => span("two\nlines")).toThrow('span text must be a single line: "two\\nlines"');
});

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

test("targetAt resolves the span under the cursor, and only that span", () => {
  expect(targetAt(doc, { line: 0, column: 0 })).toBeUndefined();
  expect(targetAt(doc, { line: 0, column: 2 })).toEqual(change);
  expect(targetAt(doc, { line: 0, column: 8 })).toEqual(change);
  expect(targetAt(doc, { line: 0, column: 9 })).toBeUndefined();
  expect(targetAt(doc, { line: 0, column: 99 })).toBeUndefined();
  expect(targetAt(doc, { line: 1, column: 0 })).toBeUndefined();
  expect(targetAt(doc, { line: 2, column: 3 })).toBeUndefined();
  expect(targetAt(doc, { line: 9, column: 0 })).toBeUndefined();
});

test("docText joins spans and lines", () => {
  expect(docText(doc)).toBe("| widgets |\n\nplain text");
});

test("span refuses multi-line text", () => {
  expect(() => span("two\nlines")).toThrow('span text must be a single line: "two\\nlines"');
});

import { span } from "cabaret-views";
import { expect, test } from "vitest";
import { styledRanges } from "../styles.js";

test("styledRanges locates styled spans on the grid, skipping empty ones", () => {
  const doc = {
    lines: [
      { spans: [span("plain "), span("Files to review:", { style: "heading" })] },
      { spans: [] },
      { spans: [span("", { style: "heading" }), span("| "), span("gizmo", { style: "heading" }), span(" |")] },
    ],
  };
  expect(styledRanges(doc)).toEqual([
    { line: 0, start: 6, length: 16, style: "heading" },
    { line: 2, start: 2, length: 5, style: "heading" },
  ]);
});

test("styledRanges of an unstyled doc is empty", () => {
  expect(styledRanges({ lines: [{ spans: [span("plain")] }] })).toEqual([]);
});

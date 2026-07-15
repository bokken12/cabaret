import { parseFilePath, parseRefName } from "cabaret-core";
import { span } from "cabaret-views";
import { expect, test } from "vitest";
import { linkRanges, styledRanges } from "../ranges.js";

test("styledRanges locates styled spans on the grid, keeping empty ones for whole-line paint", () => {
  const doc = {
    lines: [
      { spans: [span("plain "), span("Files to review:", { style: "heading" })] },
      { spans: [] },
      { spans: [span("", { style: "added" }), span("| "), span("gizmo", { style: "heading" }), span(" |")] },
    ],
    folds: [],
    errors: [],
  };
  expect(styledRanges(doc)).toEqual([
    { line: 0, start: 6, length: 16, style: "heading" },
    { line: 2, start: 0, length: 0, style: "added" },
    { line: 2, start: 2, length: 5, style: "heading" },
  ]);
});

test("styledRanges of an unstyled doc is empty", () => {
  expect(styledRanges({ lines: [{ spans: [span("plain")] }], folds: [], errors: [] })).toEqual([]);
});

test("linkRanges locates advertised links, skipping jump targets and empty spans", () => {
  const change = { kind: "change", change: parseRefName("gizmo") } as const;
  const file = { kind: "file", change: change.change, file: parseFilePath("api.ts") } as const;
  const location = { kind: "location", file: file.file, line: 3 } as const;
  const doc = {
    lines: [
      { spans: [span("├─ "), span("gizmo", { target: change })] },
      { spans: [span("const x = 1;", { target: location, tier: "jump" })] },
      { spans: [span("| "), span("api.ts", { target: file }), span(" | 2 |"), span("", { target: change })] },
    ],
    folds: [],
    errors: [],
  };
  expect(linkRanges(doc)).toEqual([
    { line: 0, start: 3, length: 5, target: change },
    { line: 2, start: 2, length: 6, target: file },
  ]);
});

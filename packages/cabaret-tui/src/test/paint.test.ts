import { parseBranchName, parseFilePath } from "cabaret-core";
import { type Doc, layout, section, span } from "cabaret-views";
import { expect, test } from "vitest";
import { foldAt, paintPage, paintStatus, visibleLines } from "../paint.js";

/** Frames with SGR escapes spelled out as «params¦, so snapshots stay readable. */
function visible(rows: readonly string[]): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escapes are what the painter emits
  return rows.map((row) => row.replaceAll(/\x1b\[([0-9;]*)m/g, "«$1¦")).join("\n");
}

const change = { kind: "change", change: parseBranchName("widgets") } as const;
const location = { kind: "location", change: change.change, file: parseFilePath("api.ts"), line: 3 } as const;

const diffish: Doc = layout([
  { spans: [span("widgets", { style: "heading" })] },
  section({ spans: [span("-1,2 +1,2", { style: "hunk", target: location, tier: "jump" })] }, [
    { spans: [span("const a = 1;", { style: "removed" }), span("", { style: "removed-word" })] },
    { spans: [span("const b = 2;", { target: location, tier: "jump" })] },
  ]),
  { spans: [span("see "), span("widgets", { target: change })] },
]);

test("paintPage washes lines, underlines links, and marks the cursor", () => {
  expect(
    visible(paintPage({ doc: diffish, folded: new Set(), cursor: 0, top: 0 }, 24, 10, "truecolor")),
  ).toMatchInlineSnapshot(`
    "«0;1;36¦❯«0¦   «0;1¦widgets«0¦
    «0¦ «0¦   «0;48;2;42;46;54¦-1,2 +1,2«0;48;2;42;46;54¦           «0¦
    «0¦ «0;48;2;70;26;26¦- «0¦ «0;48;2;70;26;26¦const a = 1;«0;48;2;70;26;26¦        «0¦
    «0¦ «0¦   «0¦const b = 2;«0¦
    «0¦ «0¦   «0¦see «0;4¦widgets«0¦"
  `);
});

test("paintPage at ansi256 depth falls back to the 256-color palette", () => {
  expect(
    visible(paintPage({ doc: diffish, folded: new Set(), cursor: 2, top: 2 }, 20, 1, "ansi256")),
  ).toMatchInlineSnapshot(`"«0;1;36¦❯«0;48;5;52¦- «0¦ «0;48;5;52¦const a = 1;«0;48;5;52¦    «0¦"`);
});

test("paintPage truncates long lines under an ellipsis", () => {
  const doc = layout([{ spans: [span("abcdefgh", { style: "added" })] }]);
  expect(visible(paintPage({ doc, folded: new Set(), cursor: 0, top: 0 }, 8, 5, "truecolor"))).toMatchInlineSnapshot(
    `"«0;1;36¦❯«0;48;2;16;56;28¦+ «0¦ «0;48;2;16;56;28¦abc«0;2¦…«0¦"`,
  );
});

test("paintPage shows a folded section as its heading wearing an ellipsis", () => {
  expect(
    visible(paintPage({ doc: diffish, folded: new Set([1]), cursor: 1, top: 0 }, 24, 10, "truecolor")),
  ).toMatchInlineSnapshot(`
    "«0¦ «0¦   «0;1¦widgets«0¦
    «0;1;36¦❯«0¦   «0;48;2;42;46;54¦-1,2 +1,2«0;2¦ …«0;48;2;42;46;54¦         «0¦
    «0¦ «0¦   «0¦see «0;4¦widgets«0¦"
  `);
});

test("visibleLines hides a folded fold's body, including folds nested in it", () => {
  const doc = layout([
    { spans: [span("before")] },
    section({ spans: [span("outer")] }, [
      section({ spans: [span("inner")] }, [{ spans: [span("leaf")] }]),
      { spans: [span("tail")] },
    ]),
    { spans: [span("after")] },
  ]);
  expect(visibleLines(doc, new Set())).toEqual([0, 1, 2, 3, 4, 5]);
  expect(visibleLines(doc, new Set([2]))).toEqual([0, 1, 2, 4, 5]);
  expect(visibleLines(doc, new Set([1, 2]))).toEqual([0, 1, 5]);
});

test("foldAt answers the innermost fold containing a line", () => {
  const doc = layout([
    section({ spans: [span("outer")] }, [
      section({ spans: [span("inner")] }, [{ spans: [span("leaf")] }]),
      { spans: [span("tail")] },
    ]),
  ]);
  expect(foldAt(doc, 0)).toEqual({ start: 0, end: 3 });
  expect(foldAt(doc, 2)).toEqual({ start: 1, end: 2 });
  expect(foldAt(doc, 3)).toEqual({ start: 0, end: 3 });
  expect(foldAt(doc, 4)).toBeUndefined();
});

test("paintStatus anchors its ends and keeps to the width", () => {
  expect(visible([paintStatus("/cabaret/home", "! r", 24)])).toMatchInlineSnapshot(
    `"«0;7¦ /cabaret/home      ! r «0¦"`,
  );
  expect(visible([paintStatus("/cabaret/show/a-very-long-change-name", "note", 20)])).toMatchInlineSnapshot(
    `"«0;7¦ /cabaret/show…note «0¦"`,
  );
});

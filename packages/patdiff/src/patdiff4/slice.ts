/** A single file's hunk, ported from Iron's [patdiff4/lib/slice.ml]. For the
 *  full 4-way hunk, see [segment.ts]. */

import * as Range from "./range.js";

export type Slice = {
  readonly range: Range.Range;
  readonly lines: readonly string[];
};

export const create = (source: string, line: number, contents: readonly string[]): Slice => ({
  range: { source, lineStart: line, lineEnd: line + contents.length },
  lines: contents,
});

export const prepend = (lines: readonly string[], t: Slice): Slice => ({
  range: Range.prepend(lines.length, t.range),
  lines: [...lines, ...t.lines],
});

export const append = (t: Slice, lines: readonly string[]): Slice => ({
  range: Range.append(t.range, lines.length),
  lines: [...t.lines, ...lines],
});

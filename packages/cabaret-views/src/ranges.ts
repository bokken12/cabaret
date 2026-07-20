import type { Doc, Style, Target } from "./doc.js";

/** A styled span located on the document grid, ready to paint as a decoration. */
export interface StyledRange {
  readonly line: number;
  readonly start: number;
  readonly length: number;
  readonly style: Style;
}

export function styledRanges(doc: Doc): readonly StyledRange[] {
  const ranges: StyledRange[] = [];
  doc.lines.forEach(({ spans }, line) => {
    let start = 0;
    for (const { text, style } of spans) {
      // An empty styled span still ranges: a whole-line wash paints a blank
      // added or removed line from its zero-length range.
      if (style !== undefined) {
        ranges.push({ line, start, length: text.length, style });
      }
      start += text.length;
    }
  });
  return ranges;
}

/** An advertised link located on the document grid; jump targets stay off it. */
export interface LinkRange {
  readonly line: number;
  readonly start: number;
  readonly length: number;
  readonly target: Target;
}

export function linkRanges(doc: Doc): readonly LinkRange[] {
  const ranges: LinkRange[] = [];
  doc.lines.forEach(({ spans }, line) => {
    let start = 0;
    for (const { text, target, tier } of spans) {
      if (target !== undefined && tier === "link" && text.length > 0) {
        ranges.push({ line, start, length: text.length, target });
      }
      start += text.length;
    }
  });
  return ranges;
}

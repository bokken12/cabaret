import type { Doc, Style } from "cabaret-views";

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
      if (style !== undefined && text.length > 0) {
        ranges.push({ line, start, length: text.length, style });
      }
      start += text.length;
    }
  });
  return ranges;
}

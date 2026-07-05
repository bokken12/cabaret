import type { Doc, Style } from "cabaret-views";

/** Every `Style`, as the semantic token legend; the mapped type keeps the list exhaustive. */
const STYLES: { readonly [S in Style]: null } = { heading: null };

export const TOKEN_TYPES: readonly Style[] = Object.keys(STYLES) as Style[];

/** A styled span located on the document grid, ready to encode as a semantic token. */
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

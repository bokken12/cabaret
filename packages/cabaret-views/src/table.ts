import { type Line, type Span, span } from "./doc.js";

export interface Column {
  readonly header: string;
  readonly align: "left" | "right";
}

/**
 * Lay rows out as a bordered table, one span per cell so cell targets map to
 * exactly the cell's text:
 *
 *     |-----------------|
 *     | change | review |
 *     |--------+--------|
 *     | root   |      1 |
 *     |-----------------|
 */
export function table(columns: readonly Column[], rows: readonly (readonly Span[])[]): readonly Line[] {
  for (const cells of rows) {
    if (cells.length !== columns.length) {
      throw new Error(`row has ${cells.length} cells for ${columns.length} columns`);
    }
  }
  const widths = columns.map((column, i) =>
    Math.max(column.header.length, ...rows.map((row) => (row[i] as Span).text.length)),
  );
  const pad = (cell: Span, width: number, align: Column["align"]): readonly Span[] => {
    const padding = span(" ".repeat(width - cell.text.length));
    if (padding.text === "") {
      return [cell];
    }
    return align === "left" ? [cell, padding] : [padding, cell];
  };
  const row = (cells: readonly Span[]): Line => {
    const spans: Span[] = [span("| ")];
    cells.forEach((cell, i) => {
      if (i > 0) {
        spans.push(span(" | "));
      }
      spans.push(...pad(cell, widths[i] as number, (columns[i] as Column).align));
    });
    spans.push(span(" |"));
    return { spans };
  };
  const border: Line = {
    spans: [span(`|${"-".repeat(widths.reduce((sum, w) => sum + w + 2, 0) + widths.length - 1)}|`)],
  };
  return [
    border,
    row(columns.map(({ header }) => span(header))),
    { spans: [span(`|${widths.map((width) => "-".repeat(width + 2)).join("+")}|`)] },
    ...rows.map(row),
    border,
  ];
}

import { type Line, type Span, span } from "./doc.js";

export interface Column {
  readonly header: string;
  readonly align: "left" | "right";
}

/** A cell's content: one span, or several laid out side by side. */
export type Cell = Span | readonly Span[];

function cellSpans(cell: Cell): readonly Span[] {
  return "text" in cell ? [cell] : cell;
}

function cellWidth(cell: Cell): number {
  return cellSpans(cell).reduce((width, { text }) => width + text.length, 0);
}

/**
 * Lay rows out as a bordered table, keeping each cell's spans intact so a
 * cell's targets map to exactly their own span's text:
 *
 *     ╭────────┬────────╮
 *     │ change │ review │
 *     ├────────┼────────┤
 *     │ root   │      1 │
 *     ╰────────┴────────╯
 */
export function table(columns: readonly Column[], rows: readonly (readonly Cell[])[]): readonly Line[] {
  for (const cells of rows) {
    if (cells.length !== columns.length) {
      throw new Error(`row has ${cells.length} cells for ${columns.length} columns`);
    }
  }
  const widths = columns.map((column, i) =>
    Math.max(column.header.length, ...rows.map((row) => cellWidth(row[i] as Cell))),
  );
  const pad = (cell: Cell, width: number, align: Column["align"]): readonly Span[] => {
    const spans = cellSpans(cell);
    const padding = span(" ".repeat(width - cellWidth(cell)));
    if (padding.text === "") {
      return spans;
    }
    return align === "left" ? [...spans, padding] : [padding, ...spans];
  };
  const row = (cells: readonly Cell[]): Line => {
    const spans: Span[] = [span("│ ")];
    cells.forEach((cell, i) => {
      if (i > 0) {
        spans.push(span(" │ "));
      }
      spans.push(...pad(cell, widths[i] as number, (columns[i] as Column).align));
    });
    spans.push(span(" │"));
    return { spans };
  };
  const rule = (left: string, joint: string, right: string): Line => ({
    spans: [span(`${left}${widths.map((width) => "─".repeat(width + 2)).join(joint)}${right}`)],
  });
  return [
    rule("╭", "┬", "╮"),
    row(columns.map(({ header }) => span(header))),
    rule("├", "┼", "┤"),
    ...rows.map(row),
    rule("╰", "┴", "╯"),
  ];
}

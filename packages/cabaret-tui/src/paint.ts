import type { Doc, Fold, Line, Style } from "cabaret-views";

/** How much color the terminal offers; truecolor terminals get the tuned palette. */
export type ColorDepth = "truecolor" | "ansi256";

interface StylePaint {
  /** SGR parameters at each color depth. */
  readonly tc: string;
  readonly lo: string;
  /** Whether the style's background washes on to the viewport's right edge. */
  readonly wash: boolean;
}

/**
 * Styles paint as SGR attributes: backgrounds wash whole lines like a
 * highlighter pen while the text keeps its own colors, so a future syntax
 * highlighter can layer foregrounds over them untouched. The diff-of-diffs
 * channels tell which diff carries a line by hue — the reviewed (old) diff
 * warms toward amber, the current (new) diff cools toward cyan — standing in
 * for a gutter sign.
 */
const PAINT: { readonly [S in Style]: StylePaint } = {
  heading: { tc: "1", lo: "1", wash: false },
  added: { tc: "48;2;16;56;28", lo: "48;5;22", wash: true },
  removed: { tc: "48;2;70;26;26", lo: "48;5;52", wash: true },
  "added-word": { tc: "48;2;24;92;44", lo: "48;5;28", wash: false },
  "removed-word": { tc: "48;2;120;40;40", lo: "48;5;88", wash: false },
  hunk: { tc: "48;2;42;46;54", lo: "48;5;237", wash: true },
  context: { tc: "2", lo: "2", wash: false },
  "old-diff-removed": { tc: "48;2;84;46;22", lo: "48;5;94", wash: true },
  "old-diff-added": { tc: "48;2;64;70;20", lo: "48;5;58", wash: true },
  "old-diff-context": { tc: "48;2;52;48;30", lo: "48;5;239", wash: true },
  "new-diff-removed": { tc: "48;2;80;28;56", lo: "48;5;89", wash: true },
  "new-diff-added": { tc: "48;2;18;66;66", lo: "48;5;23", wash: true },
  "new-diff-context": { tc: "48;2;28;44;58", lo: "48;5;238", wash: true },
};

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

function sgr(params: string): string {
  return `${ESC}0;${params}m`;
}

/** A page's display state, over the visible-line list `visibleLines` derives. */
export interface PageState {
  readonly doc: Doc;
  /** Start lines of the folds currently folded. */
  readonly folded: ReadonlySet<number>;
  /** The cursor, as an index into the visible-line list. */
  readonly cursor: number;
  /** Visible-line index of the first row on screen. */
  readonly top: number;
}

/** Zero-based doc lines still visible under `folded`: a folded fold shows only its heading. */
export function visibleLines(doc: Doc, folded: ReadonlySet<number>): readonly number[] {
  const ends = new Map(doc.folds.map(({ start, end }) => [start, end]));
  const visible: number[] = [];
  let hiddenUntil = -1;
  for (let line = 0; line < doc.lines.length; line++) {
    if (line <= hiddenUntil) {
      continue;
    }
    visible.push(line);
    const end = folded.has(line) ? ends.get(line) : undefined;
    if (end !== undefined && end > hiddenUntil) {
      hiddenUntil = end;
    }
  }
  return visible;
}

/** The innermost fold containing the zero-based doc `line`, if any. */
export function foldAt(doc: Doc, line: number): Fold | undefined {
  let innermost: Fold | undefined;
  for (const fold of doc.folds) {
    if (fold.start <= line && line <= fold.end && (innermost === undefined || fold.start > innermost.start)) {
      innermost = fold;
    }
  }
  return innermost;
}

interface LinePaint {
  readonly cursor: boolean;
  /** The line heads a folded fold, so it wears an ellipsis for its hidden body. */
  readonly folded: boolean;
  readonly width: number;
  readonly depth: ColorDepth;
}

function params(style: Style, depth: ColorDepth): string {
  const paint = PAINT[style];
  return depth === "truecolor" ? paint.tc : paint.lo;
}

/**
 * One line as ANSI text: a two-column cursor gutter, then the spans, then the
 * line's wash padded to the right edge. Text past the width truncates under a
 * trailing ellipsis. Width counts code points, not terminal cells, so
 * double-width characters overrun; a cell-width measure can replace it if
 * that bites.
 */
function paintLine(line: Line, paint: LinePaint): string {
  let out = paint.cursor ? `${sgr("1;36")}❯ ` : `${RESET}  `;
  let remaining = paint.width - 2;
  let wash: Style | undefined;
  for (const span of line.spans) {
    if (span.style !== undefined && wash === undefined && PAINT[span.style].wash) {
      wash = span.style;
    }
    if (remaining <= 0 || span.text.length === 0) {
      continue;
    }
    const attrs = [
      ...(span.style === undefined ? [] : [params(span.style, paint.depth)]),
      ...(span.target !== undefined && span.tier === "link" ? ["4"] : []),
    ];
    out += attrs.length === 0 ? RESET : sgr(attrs.join(";"));
    const text = Array.from(span.text);
    if (text.length > remaining) {
      out += `${text.slice(0, remaining - 1).join("")}${sgr("2")}…`;
      remaining = 0;
    } else {
      out += span.text;
      remaining -= text.length;
    }
  }
  if (paint.folded && remaining >= 2) {
    out += `${sgr("2")} …`;
    remaining -= 2;
  }
  if (wash !== undefined && remaining > 0) {
    out += `${sgr(params(wash, paint.depth))}${" ".repeat(remaining)}`;
  }
  return out + RESET;
}

/** The page's content rows for a `width` x `height` viewport, at most `height` of them. */
export function paintPage(state: PageState, width: number, height: number, depth: ColorDepth): readonly string[] {
  const visible = visibleLines(state.doc, state.folded);
  const rows: string[] = [];
  for (let row = state.top; row < visible.length && rows.length < height; row++) {
    const line = visible[row];
    if (line === undefined) {
      break;
    }
    const spans = state.doc.lines[line];
    if (spans === undefined) {
      break;
    }
    rows.push(
      paintLine(spans, {
        cursor: row === state.cursor,
        folded: state.folded.has(line),
        width,
        depth,
      }),
    );
  }
  return rows;
}

/** The inverse-video status row: `left` anchored at the left edge, `right` at the right. */
export function paintStatus(left: string, right: string, width: number): string {
  const leftText = Array.from(` ${left}`);
  const rightText = Array.from(right.length === 0 ? "" : `${right} `).slice(0, width);
  const room = width - rightText.length;
  const leftShown =
    leftText.length <= room
      ? `${leftText.join("")}${" ".repeat(room - leftText.length)}`
      : `${leftText.slice(0, Math.max(0, room - 1)).join("")}${room > 0 ? "…" : ""}`;
  return `${sgr("7")}${leftShown}${rightText.join("")}${RESET}`;
}

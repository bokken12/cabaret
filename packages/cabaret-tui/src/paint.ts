import type { Doc, Fold, Line, Style } from "cabaret-views";

/** How much color the terminal offers; truecolor terminals get the tuned palette. */
export type ColorDepth = "truecolor" | "ansi256";

interface StylePaint {
  /** SGR parameters at each color depth. */
  readonly tc: string;
  readonly lo: string;
  /** Whether the style's background washes on to the viewport's right edge. */
  readonly wash: boolean;
  /** The line's gutter sign; diff-of-diffs signs pair the channel's sign with the inner one. */
  readonly sign?: string | undefined;
}

/**
 * Styles paint as SGR attributes: backgrounds wash whole lines like a
 * highlighter pen while the text keeps its own colors, so a future syntax
 * highlighter can layer foregrounds over them untouched. The diff-of-diffs
 * channels also tell which diff carries a line by hue — the reviewed (old)
 * diff warms toward amber, the current (new) diff cools toward cyan.
 */
const PAINT: { readonly [S in Style]: StylePaint } = {
  heading: { tc: "1", lo: "1", wash: false },
  added: { tc: "48;2;16;56;28", lo: "48;5;22", wash: true, sign: "+" },
  removed: { tc: "48;2;70;26;26", lo: "48;5;52", wash: true, sign: "-" },
  "added-word": { tc: "48;2;24;92;44", lo: "48;5;28", wash: false },
  "removed-word": { tc: "48;2;120;40;40", lo: "48;5;88", wash: false },
  hunk: { tc: "48;2;42;46;54", lo: "48;5;237", wash: true },
  context: { tc: "2", lo: "2", wash: false },
  ready: { tc: "38;2;63;185;80", lo: "32", wash: false },
  blocked: { tc: "38;2;248;81;73", lo: "31", wash: false },
  idle: { tc: "38;2;210;153;34", lo: "33", wash: false },
  "old-diff-removed": { tc: "48;2;84;46;22", lo: "48;5;94", wash: true, sign: "--" },
  "old-diff-added": { tc: "48;2;64;70;20", lo: "48;5;58", wash: true, sign: "-+" },
  "old-diff-context": { tc: "48;2;52;48;30", lo: "48;5;239", wash: true, sign: "- " },
  "new-diff-removed": { tc: "48;2;80;28;56", lo: "48;5;89", wash: true, sign: "+-" },
  "new-diff-added": { tc: "48;2;18;66;66", lo: "48;5;23", wash: true, sign: "++" },
  "new-diff-context": { tc: "48;2;28;44;58", lo: "48;5;238", wash: true, sign: "+ " },
};

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

/** The selected rows' background; selection lives on the home page, whose lines carry no washes of their own. */
const SELECTION: StylePaint = { tc: "48;2;46;50;62", lo: "48;5;238", wash: true };

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
  /** The selection's other end, a visible-line index; unset selects the cursor alone. */
  readonly anchor?: number | undefined;
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
  /** The line sits in the selection, wearing its wash. */
  readonly selected: boolean;
  /** The line heads a folded fold, so it wears an ellipsis for its hidden body. */
  readonly folded: boolean;
  /** Whether the page carries signed lines, earning every line a sign column. */
  readonly signs: boolean;
  readonly width: number;
  readonly depth: ColorDepth;
}

function params(style: Style, depth: ColorDepth): string {
  const paint = PAINT[style];
  return depth === "truecolor" ? paint.tc : paint.lo;
}

/** The style washing the whole line, if any: the first span style that washes. */
function lineWash(line: Line): Style | undefined {
  return line.spans.find(({ style }) => style !== undefined && PAINT[style].wash)?.style;
}

/**
 * One line as ANSI text: the sign column on pages that wear signs, then the
 * spans, then the line's wash padded to the right edge — the selection wash
 * standing in on selected lines whose spans bring no background of their
 * own. Text past the width truncates under a trailing ellipsis. Width
 * counts code points, not terminal cells, so double-width characters
 * overrun; a cell-width measure can replace it if that bites.
 */
function paintLine(line: Line, paint: LinePaint): string {
  const wash = lineWash(line);
  const selection = paint.selected ? (paint.depth === "truecolor" ? SELECTION.tc : SELECTION.lo) : undefined;
  let out = "";
  if (paint.signs) {
    const sign = wash === undefined ? undefined : PAINT[wash].sign;
    out +=
      sign === undefined || wash === undefined
        ? `${selection === undefined ? RESET : sgr(selection)}   `
        : `${sgr(params(wash, paint.depth))}${sign.padEnd(2)}${RESET} `;
  }
  let remaining = paint.width - (paint.signs ? 3 : 0);
  for (const span of line.spans) {
    if (remaining <= 0 || span.text.length === 0) {
      continue;
    }
    const attrs = [
      ...(span.style === undefined ? [] : [params(span.style, paint.depth)]),
      ...(selection === undefined || (span.style !== undefined && PAINT[span.style].wash) ? [] : [selection]),
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
  const pad = wash === undefined ? selection : params(wash, paint.depth);
  if (pad !== undefined && remaining > 0) {
    out += `${sgr(pad)}${" ".repeat(remaining)}`;
  }
  return out + RESET;
}

/** Columns before a line's text: the sign column on pages that wear signs, nothing elsewhere. */
export function gutterWidth(doc: Doc): number {
  const signed = doc.lines.some((line) => {
    const wash = lineWash(line);
    return wash !== undefined && PAINT[wash].sign !== undefined;
  });
  return signed ? 3 : 0;
}

/** The page's content rows for a `width` x `height` viewport, at most `height` of them. */
export function paintPage(state: PageState, width: number, height: number, depth: ColorDepth): readonly string[] {
  const visible = visibleLines(state.doc, state.folded);
  const signs = gutterWidth(state.doc) === 3;
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
    const anchor = state.anchor;
    rows.push(
      paintLine(spans, {
        selected:
          anchor !== undefined && Math.min(anchor, state.cursor) <= row && row <= Math.max(anchor, state.cursor),
        folded: state.folded.has(line),
        signs,
        width,
        depth,
      }),
    );
  }
  return rows;
}

/**
 * How the status row wears its text: quiet inverse video for the page path
 * and passing reports, a warning band for a question that must not be
 * missed.
 */
export type StatusStyle = "quiet" | "ask";

/**
 * The status row: `text` alone on the line, left-anchored. Overflow keeps
 * the tail — a question's answer hint ends it.
 */
export function paintStatus(text: string, width: number, style: StatusStyle = "quiet"): string {
  const shown = Array.from(` ${text}`);
  const row =
    shown.length <= width
      ? `${shown.join("")}${" ".repeat(width - shown.length)}`
      : `…${shown.slice(shown.length - width + 1).join("")}`;
  return `${sgr(style === "ask" ? "1;30;43" : "7")}${row}${RESET}`;
}

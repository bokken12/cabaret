import type { Doc, Fold, Line, Style } from "cabaret-views";
import { followTarget } from "./follow.js";
import { pageHash } from "./router.js";

interface StylePaint {
  /** Whether the style's background washes the whole line to the viewport's right edge. */
  readonly wash: boolean;
  /** The line's gutter sign; diff-of-diffs signs pair the channel's sign with the inner one. */
  readonly sign?: string | undefined;
}

/** Which styles wash and sign, mirroring the tui painter so pages read alike. */
const PAINT: { readonly [S in Style]: StylePaint } = {
  heading: { wash: false },
  added: { wash: true, sign: "+" },
  removed: { wash: true, sign: "-" },
  "added-word": { wash: false },
  "removed-word": { wash: false },
  hunk: { wash: true },
  context: { wash: false },
  ready: { wash: false },
  blocked: { wash: false },
  "old-diff-removed": { wash: true, sign: "--" },
  "old-diff-added": { wash: true, sign: "-+" },
  "old-diff-context": { wash: true, sign: "- " },
  "new-diff-removed": { wash: true, sign: "+-" },
  "new-diff-added": { wash: true, sign: "++" },
  "new-diff-context": { wash: true, sign: "+ " },
};

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

/** The style washing the whole line, if any: the first span style that washes. */
function lineWash(line: Line): Style | undefined {
  return line.spans.find(({ style }) => style !== undefined && PAINT[style].wash)?.style;
}

/** Whether any line carries a signed wash, earning the page a sign gutter. */
function hasSigns(doc: Doc): boolean {
  return doc.lines.some((line) => {
    const wash = lineWash(line);
    return wash !== undefined && PAINT[wash].sign !== undefined;
  });
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function renderSpans(line: Line): string {
  let html = "";
  for (const span of line.spans) {
    const text = escapeHtml(span.text);
    const styled = span.style === undefined ? undefined : `s-${span.style}`;
    if (span.target !== undefined && span.tier === "link") {
      const classes = styled === undefined ? "link" : `link ${styled}`;
      const followed = followTarget(span.target);
      switch (followed.kind) {
        case "page":
          html += `<a class="${classes}" href="${escapeHtml(pageHash(followed.page))}">${text}</a>`;
          break;
        case "external":
          html += `<a class="${classes}" href="${escapeHtml(followed.url)}" target="_blank" rel="noreferrer">${text}</a>`;
          break;
        case "note":
          html += `<a class="${classes}" data-note="${escapeHtml(followed.text)}">${text}</a>`;
          break;
      }
    } else if (styled !== undefined) {
      html += `<span class="${styled}">${text}</span>`;
    } else {
      html += text;
    }
  }
  return html;
}

/**
 * The doc's visible lines as HTML: one div per line, its wash as a class on
 * the div so the background runs the viewport's width, link spans as real
 * anchors. The cursor is the host's to place — it moves without repainting.
 */
export function renderContent(doc: Doc, folded: ReadonlySet<number>): string {
  const signs = hasSigns(doc);
  const foldStarts = new Set(doc.folds.map(({ start }) => start));
  return visibleLines(doc, folded)
    .map((index) => {
      const line = doc.lines[index];
      if (line === undefined) {
        throw new Error(`visible line ${index} is off the doc`);
      }
      const wash = lineWash(line);
      const isFolded = folded.has(index);
      let html = `<div class="line${wash === undefined ? "" : ` w-${wash}`}" data-line="${index}">`;
      if (foldStarts.has(index)) {
        html += `<span class="fold-mark" title="toggle fold">${isFolded ? "▸" : "▾"}</span>`;
      }
      if (signs) {
        const sign = wash === undefined ? undefined : PAINT[wash].sign;
        html += `<span class="gutter">${escapeHtml((sign ?? "").padEnd(2))} </span>`;
      }
      html += renderSpans(line);
      if (isFolded) {
        html += `<span class="dim"> …</span>`;
      }
      return `${html}</div>`;
    })
    .join("\n");
}

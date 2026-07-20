import type { Doc, Fold, Line, Style } from "cabaret-views";
import { followTarget } from "./follow.js";
import type { CodeHighlighter, CodeToken } from "./highlight.js";
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

/** The styles source text wears in a diff body — the lines highlighting may color. */
const CODE_STYLES: ReadonlySet<Style> = new Set([
  "added",
  "removed",
  "added-word",
  "removed-word",
  "context",
  "old-diff-removed",
  "old-diff-added",
  "old-diff-context",
  "new-diff-removed",
  "new-diff-added",
  "new-diff-context",
]);

/**
 * Whether every span is source text, with nothing — headings, links — a
 * token color could misclaim. Jump targets are source text still: hunk body
 * lines carry their location anchor on the first span.
 */
function isCodeLine(line: Line): boolean {
  return line.spans.every(
    ({ style, target, tier }) =>
      (target === undefined || tier === "jump") && (style === undefined || CODE_STYLES.has(style)),
  );
}

/**
 * The file whose source each line shows: the innermost enclosing fold whose
 * heading names one — the per-file sections of the diffs page, the hunk
 * headings within. Lines outside any such fold show no file's source.
 */
export function lineFiles(doc: Doc): ReadonlyMap<number, string> {
  const files = new Map<number, string>();
  const named = doc.folds
    .map((fold) => {
      const heading = doc.lines[fold.start];
      const target = heading?.spans.find(({ target: at }) => at?.kind === "file" || at?.kind === "location")?.target;
      const file = target?.kind === "file" || target?.kind === "location" ? target.file : undefined;
      return file === undefined ? undefined : { fold, file };
    })
    .filter((entry) => entry !== undefined);
  // Ascending starts: an inner fold assigns after — so over — its enclosers.
  named.sort((a, b) => a.fold.start - b.fold.start);
  for (const { fold, file } of named) {
    for (let line = fold.start + 1; line <= fold.end; line++) {
      files.set(line, file);
    }
  }
  return files;
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

/**
 * One span's text under the line's token colors: the tokens covering the
 * span's slice of the line, each colored run its own element, so word
 * washes keep their spans while tokens color the text within.
 */
function colorSpan(text: string, from: number, tokens: readonly CodeToken[]): string {
  let html = "";
  let at = 0;
  for (const token of tokens) {
    const start = Math.max(from, at);
    const end = Math.min(from + text.length, at + token.text.length);
    at += token.text.length;
    if (end <= start) {
      continue;
    }
    const chunk = escapeHtml(text.slice(start - from, end - from));
    html += token.color === undefined ? chunk : `<span style="color:${token.color}">${chunk}</span>`;
  }
  // Text past the tokens — trailing whitespace grammars drop — stays plain.
  const covered = Math.max(0, at - from);
  return html + escapeHtml(text.slice(covered));
}

function renderSpans(line: Line, tokens?: readonly CodeToken[]): string {
  let html = "";
  let offset = 0;
  for (const span of line.spans) {
    const from = offset;
    offset += span.text.length;
    const text = tokens === undefined ? escapeHtml(span.text) : colorSpan(span.text, from, tokens);
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
 * anchors, source lines token-colored by the highlighter under their diff
 * washes. The cursor is the host's to place — it moves without repainting.
 */
export function renderContent(doc: Doc, folded: ReadonlySet<number>, highlighter?: CodeHighlighter): string {
  const signs = hasSigns(doc);
  const foldStarts = new Set(doc.folds.map(({ start }) => start));
  const files = highlighter === undefined ? undefined : lineFiles(doc);
  return visibleLines(doc, folded)
    .map((index) => {
      const line = doc.lines[index];
      if (line === undefined) {
        throw new Error(`visible line ${index} is off the doc`);
      }
      const file = files?.get(index);
      const tokens =
        highlighter !== undefined && file !== undefined && isCodeLine(line)
          ? highlighter.tokens(file, line.spans.map(({ text }) => text).join(""))
          : undefined;
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
      html += renderSpans(line, tokens);
      if (isFolded) {
        html += `<span class="dim"> …</span>`;
      }
      return `${html}</div>`;
    })
    .join("\n");
}

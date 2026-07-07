import type { Doc, Span } from "cabaret-views";

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ESCAPES[char] as string);
}

function spanHtml(span: Span): string {
  const classes = [...(span.style === undefined ? [] : [span.style]), ...(span.target === undefined ? [] : ["target"])];
  const text = escapeHtml(span.text);
  return classes.length === 0 ? text : `<span class="${classes.join(" ")}">${text}</span>`;
}

/**
 * The doc as HTML: one `div` per line, indexed by `data-line` so a click
 * hit-tests against the doc with `targetAt` — the same line granularity a
 * cursor host uses. Styles become classes for the stylesheet to paint, and
 * spans with targets are marked for hover affordance.
 */
export function docHtml(doc: Doc): string {
  return doc.lines
    .map(({ spans }, line) => `<div class="line" data-line="${line}">${spans.map(spanHtml).join("")}</div>`)
    .join("\n");
}

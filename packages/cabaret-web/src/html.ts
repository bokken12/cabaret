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

function spanHtml(span: Span, index: number): string {
  const link = span.tier === "link";
  const classes = [...(span.style === undefined ? [] : [span.style]), ...(link ? ["target"] : [])];
  const text = escapeHtml(span.text);
  if (classes.length === 0) {
    return text;
  }
  return `<span class="${classes.join(" ")}"${link ? ` data-span="${index}"` : ""}>${text}</span>`;
}

/**
 * The doc as HTML: one `div` per line, indexed by `data-line`, and inside it
 * one `data-span`-indexed span per advertised link, so a click on exactly
 * that text resolves back to its target. Styles become classes for the
 * stylesheet to paint; link spans are also marked for hover affordance, while
 * jump targets show no affordance and answer no click.
 */
export function docHtml(doc: Doc): string {
  return doc.lines
    .map(({ spans }, line) => `<div class="line" data-line="${line}">${spans.map(spanHtml).join("")}</div>`)
    .join("\n");
}

import type { FilePath, ForgeRequestId, RefName } from "cabaret-core";

/** Semantic paint for a span; each host maps styles to its own palette. */
export type Style = "heading" | "added" | "removed";

/** What a span denotes, for hosts to dispatch on at the cursor. */
export type Target =
  | { readonly kind: "change"; readonly change: RefName }
  | { readonly kind: "file"; readonly change: RefName; readonly file: FilePath }
  /** A position in a file's current copy: `line` is 1-based. */
  | { readonly kind: "location"; readonly file: FilePath; readonly line: number }
  /** A forge request with no change log yet; `change` names the change importing it would create. */
  | { readonly kind: "request"; readonly request: ForgeRequestId; readonly change: RefName };

/** A run of single-line text, optionally styled and denoting a target. */
export interface Span {
  readonly text: string;
  readonly style?: Style | undefined;
  readonly target?: Target | undefined;
}

export interface Line {
  readonly spans: readonly Span[];
}

/** A rendered page: plain text in which every meaningful span knows what it denotes. */
export interface Doc {
  readonly lines: readonly Line[];
}

/** Make a span; multi-line text would break line-to-target mapping, so it is refused. */
export function span(text: string, opts?: { style?: Style; target?: Target }): Span {
  if (text.includes("\n")) {
    throw new Error(`span text must be a single line: ${JSON.stringify(text)}`);
  }
  return { text, style: opts?.style, target: opts?.target };
}

/**
 * The target the zero-based `line` denotes, or undefined for a plain line.
 * The whole line resolves to its first target: selecting a line is the
 * granularity a cursor should need, not a column within it.
 */
export function targetAt(doc: Doc, line: number): Target | undefined {
  return doc.lines[line]?.spans.find(({ target }) => target !== undefined)?.target;
}

/** The doc as plain text — how a host that paints no styles displays it. */
export function docText(doc: Doc): string {
  return doc.lines.map((line) => line.spans.map(({ text }) => text).join("")).join("\n");
}

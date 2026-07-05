import type { FilePath, RefName } from "cabaret-core";

/** Semantic paint for a span; each host maps styles to its own palette. */
export type Style = "heading";

/** What a span denotes, for hosts to dispatch on at the cursor. */
export type Target =
  | { readonly kind: "change"; readonly change: RefName }
  | { readonly kind: "file"; readonly change: RefName; readonly file: FilePath };

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

/** A zero-based cursor position within a doc. */
export interface Position {
  readonly line: number;
  readonly column: number;
}

/** Make a span; multi-line text would break position-to-target mapping, so it is refused. */
export function span(text: string, opts?: { style?: Style; target?: Target }): Span {
  if (text.includes("\n")) {
    throw new Error(`span text must be a single line: ${JSON.stringify(text)}`);
  }
  return { text, style: opts?.style, target: opts?.target };
}

/** The target under `position`, or undefined over plain text. */
export function targetAt(doc: Doc, position: Position): Target | undefined {
  let start = 0;
  for (const { text, target } of doc.lines[position.line]?.spans ?? []) {
    const end = start + text.length;
    if (position.column >= start && position.column < end) {
      return target;
    }
    start = end;
  }
  return undefined;
}

/** The doc as plain text — how a host that paints no styles displays it. */
export function docText(doc: Doc): string {
  return doc.lines.map((line) => line.spans.map(({ text }) => text).join("")).join("\n");
}

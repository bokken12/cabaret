import type { FilePath, RefName } from "cabaret-core";

/**
 * Semantic paint for a span; each host maps styles to its own palette. The
 * word styles mark the words that actually changed within a line — over the
 * line's own style on an added or removed line, and alone on a unified line
 * whose kept text is plain.
 */
export type Style = "heading" | "added" | "removed" | "added-word" | "removed-word" | "hunk";

/** What a span denotes, for hosts to dispatch on at the cursor. */
export type Target =
  | { readonly kind: "change"; readonly change: RefName }
  | { readonly kind: "file"; readonly change: RefName; readonly file: FilePath }
  /** A position in a file's current copy: `line` is 1-based. */
  | { readonly kind: "location"; readonly file: FilePath; readonly line: number };

/**
 * How hosts offer a span's target: a link is advertised as clickable, while a
 * jump answers only an explicit ask, like Enter at the cursor.
 */
export type TargetTier = "link" | "jump";

/** A run of single-line text, optionally styled and denoting a target. */
export interface Span {
  readonly text: string;
  readonly style?: Style | undefined;
  readonly target?: Target | undefined;
  /** Present exactly when `target` is: `span` supplies the default. */
  readonly tier?: TargetTier | undefined;
}

export interface Line {
  readonly spans: readonly Span[];
}

/** A rendered page: plain text in which every meaningful span knows what it denotes. */
export interface Doc {
  readonly lines: readonly Line[];
}

/** Make a span; multi-line text would break line-to-target mapping, so it is refused. */
export function span(text: string, opts?: { style?: Style; target?: Target; tier?: TargetTier }): Span {
  if (text.includes("\n")) {
    throw new Error(`span text must be a single line: ${JSON.stringify(text)}`);
  }
  if (opts?.tier !== undefined && opts.target === undefined) {
    throw new Error("a span's tier qualifies its target; it cannot stand alone");
  }
  return {
    text,
    style: opts?.style,
    target: opts?.target,
    tier: opts?.target === undefined ? undefined : (opts.tier ?? "link"),
  };
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

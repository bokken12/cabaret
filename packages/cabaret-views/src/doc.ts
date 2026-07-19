import type { ChangeName, FilePath, UserName } from "cabaret-core";

/**
 * Semantic paint for a span; each host maps styles to its own palette. The
 * word styles mark the words that actually changed within a line — over the
 * line's own style on an added or removed line, and alone on a unified line
 * whose kept text is plain. Context marks material shown only to situate its
 * neighbors, for hosts to dim.
 *
 * The diff-of-diffs styles carry a 4-way conflict's second channel: a line
 * present in only the reviewed diff (old) or only the current diff (new),
 * with the inner diff's own sign — removed, added, or that diff's context.
 * Lines both diffs agree on wear the plain added/removed styles.
 */
export type Style =
  | "heading"
  | "added"
  | "removed"
  | "added-word"
  | "removed-word"
  | "hunk"
  | "context"
  | "old-diff-removed"
  | "old-diff-added"
  | "old-diff-context"
  | "new-diff-removed"
  | "new-diff-added"
  | "new-diff-context";

/** What a span denotes, for hosts to dispatch on at the cursor. */
export type Target =
  | { readonly kind: "change"; readonly change: ChangeName }
  /** A user's review of `change`: the files they have left to read. */
  | { readonly kind: "review"; readonly change: ChangeName; readonly as: UserName }
  /** A file's diff in `change` — `as` names whose review it shows when not the current user's. */
  | { readonly kind: "file"; readonly change: ChangeName; readonly file: FilePath; readonly as?: UserName | undefined }
  /** A position in a file's current copy within `change`: `line` is 1-based. */
  | { readonly kind: "location"; readonly change: ChangeName; readonly file: FilePath; readonly line: number }
  /** A workspace's directory: `path` is absolute. */
  | { readonly kind: "workspace"; readonly path: string };

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

/** A foldable region of a page: `heading` stays visible when folded, `body` folds away. */
export interface Section {
  readonly heading: Line;
  readonly body: readonly Node[];
}

/** What pages are built from: plain lines, and sections, which may nest. */
export type Node = Line | Section;

function isSection(node: Node): node is Section {
  return "heading" in node;
}

/** A run of lines a host may fold down to its first — a section's heading. */
export interface Fold {
  /** Zero-based line that stays visible when folded. */
  readonly start: number;
  /** Zero-based last line the fold hides. */
  readonly end: number;
}

/** A rendered page: plain text in which every meaningful span knows what it denotes. */
export interface Doc {
  readonly lines: readonly Line[];
  /** Regions a host may offer to fold, ordered by start line. */
  readonly folds: readonly Fold[];
  /**
   * What the page could not show — state it failed to read rather than
   * content. Hosts surface these beside the page (stderr, a notification),
   * where they cannot be mistaken for what the page says.
   */
  readonly errors: readonly string[];
}

/** Make a section; an empty body would give folding nothing to hide, so it is refused. */
export function section(heading: Line, body: readonly Node[]): Section {
  if (body.length === 0) {
    throw new Error("a section's body cannot be empty");
  }
  return { heading, body };
}

/** Lay nodes out on the line grid, deriving each section's fold from its extent. */
export function layout(nodes: readonly Node[], errors: readonly string[] = []): Doc {
  const lines: Line[] = [];
  const folds: Fold[] = [];
  const walk = (node: Node): void => {
    if (!isSection(node)) {
      lines.push(node);
      return;
    }
    const start = lines.length;
    lines.push(node.heading);
    for (const child of node.body) {
      walk(child);
    }
    folds.push({ start, end: lines.length - 1 });
  };
  for (const node of nodes) {
    walk(node);
  }
  folds.sort((a, b) => a.start - b.start);
  return { lines, folds, errors };
}

/** Make a span; multi-line text would break line-to-target mapping, so it is refused. */
export function span(
  text: string,
  opts?: { style?: Style | undefined; target?: Target | undefined; tier?: TargetTier | undefined },
): Span {
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

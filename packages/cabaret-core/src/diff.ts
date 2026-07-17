// The kernel entry, not `patdiff`, whose Node-flavored PatdiffCore reads the
// filesystem and console — imports a browser host cannot load.
import { IsBinary, PatdiffCore } from "patdiff/kernel";
import * as Patdiff4 from "patdiff/patdiff4";
import type { Backend, FilePath, ReviewedDiff, Revision } from "./backend.js";

/** Hashes display abbreviated; full hashes travel in structured data, never prose. */
export function shortHash(hash: Revision): string {
  return hash.slice(0, 12);
}

/** The versions a file's round of review compares. */
export type DiffView =
  /** A plain two-way diff; an absent version diffs against the empty file. */
  | { readonly kind: "two"; readonly prev: string | undefined; readonly next: string | undefined }
  /** The base's copy changed under the review: a 4-way diff of the reviewed and current diffs. */
  | {
      readonly kind: "four";
      readonly revs: Patdiff4.Diamond.Diamond<Revision>;
      readonly contents: Patdiff4.Diamond.Diamond<string | undefined>;
    };

/**
 * The view of a file whose base moved under its review. The two-way diff from
 * the reviewed tip stays sound when the base's copy is unchanged (the
 * reviewed diff's start is intact) or the new base took the reviewed tip's
 * copy (the whole new diff starts at contents the reviewer knows); otherwise
 * the base's copy changed underneath the review, which takes a 4-way diff.
 */
export async function rebasedView(
  backend: Backend,
  file: FilePath,
  reviewed: ReviewedDiff,
  base: Revision,
  end: Revision,
): Promise<DiffView> {
  const [prevBase, nextBase, prevTip, nextTip] = await Promise.all([
    backend.readFile(reviewed.base, file),
    backend.readFile(base, file),
    backend.readFile(reviewed.tip, file),
    backend.readFile(end, file),
  ]);
  return prevBase === nextBase || nextBase === prevTip
    ? { kind: "two", prev: prevTip, next: nextTip }
    : {
        kind: "four",
        revs: { b1: reviewed.base, b2: base, f1: reviewed.tip, f2: end },
        contents: { b1: prevBase, b2: nextBase, f1: prevTip, f2: nextTip },
      };
}

/** Lines of context around diff hunks when the host does not choose, as git. */
export const defaultContext = 3;

/**
 * Render the diff between two versions of `file` with patdiff: ANSI-colored
 * with word-level refinement on a terminal, plain ASCII otherwise. An absent
 * version diffs against the empty file. Hunks keep `context` lines of
 * surrounding context; -1 shows files whole.
 */
export function renderDiff(
  file: FilePath,
  prev: string | undefined,
  next: string | undefined,
  color: boolean,
  context?: number,
): string {
  if (IsBinary.string(prev ?? "") || IsBinary.string(next ?? "")) {
    return prev === next ? "" : `Binary versions of ${file} differ\n`;
  }
  const diff = PatdiffCore.withoutUnix.patdiff({
    output: color ? "Ansi" : "Ascii",
    context: context ?? defaultContext,
    // Unified lines are unsupported in Ascii output.
    produceUnifiedLines: color,
    // Splitting a long modified line into partial context and changed pieces
    // would break the line-per-source-line mapping structured hosts rely on.
    splitLongLines: color,
    // Names are never printed, but patdiff's language-specific whitespace
    // heuristics read them.
    prev: { name: file, text: prev ?? "" },
    next: { name: file, text: next ?? "" },
  });
  return diff === "" ? "" : `${diff}\n`;
}

interface Diff4Args {
  readonly file: FilePath;
  readonly revs: Patdiff4.Diamond.Diamond<Revision>;
  readonly contents: Patdiff4.Diamond.Diamond<string | undefined>;
  readonly color: boolean;
  readonly context?: number | undefined;
}

/**
 * Render what remains to review when the base's copy of `file` changed
 * underneath the reviewed diff: Iron's diff4 over the old and new base and
 * tip, each aligned hunk shown under its equivalence class's view. Empty
 * when nothing is left to show.
 */
export function renderDiff4(args: Diff4Args): readonly Patdiff4.Line[] {
  // TODO: name absent versions distinctly (Iron renders them as <absent>
  // with a per-version file-name table) instead of diffing an empty file.
  const contents = Patdiff4.Diamond.map(args.contents, (text) => text ?? "");
  if (!Patdiff4.Diamond.forAll(contents, (text) => !IsBinary.string(text))) {
    return [{ text: `Binary versions of ${args.file} differ`, kind: undefined, provenance: {} }];
  }
  const context = args.context ?? defaultContext;
  return Patdiff4.diff({
    // Hash prefixes keep patdiff4's contract that equal names imply equal
    // contents, where "old"/"new" labels would not (the tips can coincide).
    revNames: Patdiff4.Diamond.map(args.revs, shortHash),
    fileNames: Patdiff4.Diamond.singleton(args.file),
    headerFileName: args.file,
    context: context < 0 ? Patdiff4.DiffAlgo.infiniteContext : context,
    linesRequiredToSeparateDdiffHunks: 0,
    contents,
    output: args.color ? "Ansi" : "Ascii",
  });
}

/**
 * The same diff4 as structure, for hosts that render and fold themselves.
 * Binary versions are the caller's to detect, as with 2-way structured
 * diffs; absent versions diff as empty files.
 */
export function structuredDiff4(args: Omit<Diff4Args, "color" | "file">): readonly Patdiff4.StructuredHunk[] {
  const context = args.context ?? defaultContext;
  return Patdiff4.structuredHunks({
    revNames: Patdiff4.Diamond.map(args.revs, shortHash),
    context: context < 0 ? Patdiff4.DiffAlgo.infiniteContext : context,
    linesRequiredToSeparateDdiffHunks: 0,
    contents: Patdiff4.Diamond.map(args.contents, (text) => text ?? ""),
  });
}

/**
 * Whether `view` renders nothing to read: a two-way diff with no hunks, or a
 * four-way diff whose reviewed and current diffs agree everywhere. Emptiness
 * is the same at every color and context setting, so one rendering answers
 * for all.
 */
export function diffViewEmpty(file: FilePath, view: DiffView): boolean {
  return view.kind === "two"
    ? renderDiff(file, view.prev, view.next, false) === ""
    : renderDiff4({ file, revs: view.revs, contents: view.contents, color: false }).length === 0;
}

/** 4-way diffs over the four versions of a file around a rebase, ported from
 *  Iron's [patdiff4/lib/patdiff4.ml].
 *
 *  Given old base (b1), old tip (f1), new base (b2), and new tip (f2), a
 *  4-way diff shows a reviewer who already knows the b1→f1 diff exactly what
 *  changed about the diff itself — degenerating hunk-by-hunk to plain 2-way
 *  diffs, hidden clean merges, or a ddiff (a diff of two diffs) as the four
 *  slices' equalities allow.
 *
 *  The port assumes what Iron documents for [rev_names]: equal names imply
 *  equal contents. */

import type { Diamond, Node } from "./diamond.js";
import * as DiffAlgo from "./diff-algo.js";
import * as Diff4Class from "./diff4-class.js";
import type { Output4 } from "./header.js";
import * as Hunk from "./hunk.js";
import * as Segments from "./segments.js";
import type * as Slice from "./slice.js";

export * as Diamond from "./diamond.js";
export type { Line, LineKind, Provenance } from "./diff-algo.js";
export * as DiffAlgo from "./diff-algo.js";
export * as Diff4Class from "./diff4-class.js";
export type { Output4 } from "./header.js";
export * as Header from "./header.js";
export * as Hunk from "./hunk.js";
export * as Segment from "./segment.js";
export * as Segments from "./segments.js";
export * as Slice from "./slice.js";

export type HunksArgs = {
  readonly revNames: Diamond<string>;
  readonly fileNames: Diamond<string>;
  readonly headerFileName: string;
  readonly context: number;
  readonly linesRequiredToSeparateDdiffHunks: number;
  readonly contents: Diamond<string>;
  readonly output: Output4;
};

export const hunks = (args: HunksArgs): readonly Hunk.Hunk[] =>
  Segments.ofFiles({
    revNames: args.revNames,
    context: args.context,
    linesRequiredToSeparateDdiffHunks: args.linesRequiredToSeparateDdiffHunks,
    contents: args.contents,
  }).flatMap((segment) => {
    const shownClass = Diff4Class.shownClassOf(segment.diff4Class);
    if (shownClass === undefined) return [];
    const blocks = DiffAlgo.applyClassView(DiffAlgo.classView(shownClass), {
      includeHunkBreaks: true,
      diff4Class: segment.diff4Class,
      context: args.context,
      output: args.output,
      slices: segment.slice,
    });
    return [
      {
        headerFileName: args.headerFileName,
        revNames: args.revNames,
        fileNames: args.fileNames,
        diff4Class: segment.diff4Class,
        blocks,
      },
    ];
  });

/** All the steps of a full 4-way diff: aligned hunks, each rendered under its
 *  class's view, as display lines carrying their provenance in the four
 *  versions. */
export const diff = (args: HunksArgs): readonly DiffAlgo.Line[] => Hunk.listToLines(hunks(args), args.output);

/** One aligned hunk's view as structure, for hosts that render and fold
 *  themselves: 2-way blocks carry the diamond nodes to diff so the host runs
 *  its own diff over the slices; a conflict's ddiff comes as computed lines. */
export type StructuredBlock =
  | { readonly kind: "diff2"; readonly hints: readonly string[]; readonly from: Node; readonly to: Node }
  | { readonly kind: "ddiff"; readonly hints: readonly string[]; readonly lines: readonly DiffAlgo.DdiffLine[] };

export type StructuredHunk = {
  readonly diff4Class: Diff4Class.ShownClass;
  readonly slices: Diamond<Slice.Slice>;
  readonly blocks: readonly StructuredBlock[];
};

export type StructuredArgs = {
  readonly revNames: Diamond<string>;
  readonly context: number;
  readonly linesRequiredToSeparateDdiffHunks: number;
  readonly contents: Diamond<string>;
};

export const structuredHunks = (args: StructuredArgs): readonly StructuredHunk[] =>
  Segments.ofFiles(args).flatMap((segment) => {
    const shownClass = Diff4Class.shownClassOf(segment.diff4Class);
    if (shownClass === undefined) return [];
    const view = DiffAlgo.classView(shownClass);
    const blocks: StructuredBlock[] =
      view.kind === "diffs"
        ? view.blocks.map((block) => ({ kind: "diff2", ...block }))
        : [{ kind: "ddiff", hints: view.hints, lines: DiffAlgo.featureDdiffLines(segment.slice) }];
    return [{ diff4Class: shownClass, slices: segment.slice, blocks }];
  });

// TODO: when cabaret grows a review-obligation model, port Iron's
// [num_lines_to_review]: the line count of each hunk's view at context 0 with
// no hunk breaks and hints excluded. Iron stores it per diff4 to size
// outstanding review and to mark zero-line diffs implicitly reviewed, which
// is what clears benign rebases from every reviewer's queue without a session.

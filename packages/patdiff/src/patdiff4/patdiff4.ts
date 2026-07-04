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

import type { Diamond } from "./diamond.js";
import * as DiffAlgo from "./diff-algo.js";
import * as Diff4Class from "./diff4-class.js";
import type { Output4 } from "./header.js";
import * as Hunk from "./hunk.js";
import * as Segments from "./segments.js";

export * as Diamond from "./diamond.js";
export * as DiffAlgo from "./diff-algo.js";
export * as DiffAlgoId from "./diff-algo-id.js";
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
    const views = DiffAlgo.selectAlgosForReview(shownClass).map((algo) =>
      algo.apply({
        includeHunkBreaks: true,
        diff4Class: segment.diff4Class,
        context: args.context,
        output: args.output,
        slices: segment.slice,
      }),
    );
    if (views.length === 0) return [];
    return [
      {
        headerFileName: args.headerFileName,
        revNames: args.revNames,
        fileNames: args.fileNames,
        diff4Class: segment.diff4Class,
        views,
      },
    ];
  });

/** All the steps of a full 4-way diff: aligned hunks, each rendered under
 *  every view its class earns, as display lines. */
export const diff = (args: HunksArgs): readonly string[] => Hunk.listToLines(hunks(args), args.output);

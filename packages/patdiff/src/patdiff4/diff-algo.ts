/** The ways a 4-way hunk can be displayed, and which of them each
 *  equivalence class earns. Ported from Iron's [patdiff4/lib/diff_algo.ml].
 *
 *  ```
 *  +-----------------------+----------------+-------------------------+
 *  | equivalence classes   | show           | comment                 |
 *  |-----------------------+----------------+-------------------------|
 *  | { B1, B2, F1, F2 }    | nothing        | no changes              |
 *  | { B1, B2, F1 }        | B2->F2         | new diff                |
 *  | { B1, B2, F2 }        | F1->F2         | dropped feature change  |
 *  | { B1, B2 } { F1, F2 } | nothing        | clean merge             |
 *  | { B1, B2 }            | F1->F2         | diff extension          |
 *  | { B1, F1, F2 }        | B2->F2         | dropped base change     |
 *  | { B1, F1 } { B2, F2 } | nothing        | clean merge             |
 *  | { B1, F1 }            | B2->F2         | new diff                |
 *  | { B1, F2 } { B2, F1 } | B2->F2         | dropped same change     |
 *  | { B1, F2 }            | F1->F2, B2->F2 | dropped both changes*   |
 *  | { B2, F1, F2 }        | nothing        | same change             |
 *  | { B2, F1 }            | B2->F2         | diff extension          |
 *  | { B2, F2 }            | B1->F1, F1->F2 | dropped feature change* |
 *  | { F1, F2 }            | B1->B2, B2->F2 | dropped base change*    |
 *  | { }                   | ???            | conflict                |
 *  +-----------------------+----------------+-------------------------+
 *  ``` */

import type * as Format from "../kernel/format.js";
import { defaultLineBigEnough, defaultWordBigEnough, withoutUnix } from "../kernel/patdiff-core.js";
import { Hunks as PatienceHunks } from "../patience-diff/patience-diff.js";
import type { Diamond as DiamondT, Node } from "./diamond.js";
import * as Diamond from "./diamond.js";
import type { DiffAlgoId as Id } from "./diff-algo-id.js";
import * as DiffAlgoId from "./diff-algo-id.js";
import * as Diff4Class from "./diff4-class.js";
import * as FormatRules from "./format-rules.js";
import * as Header from "./header.js";
import * as Range from "./range.js";
import * as Slice from "./slice.js";

/** A context wider than any file. The 4-way pipeline sizes and compares
 *  context arithmetically, so infinity is a large count, not patdiff's
 *  negative sentinel. */
export const infiniteContext = 100_000;

/** Where a line's content lives: its 1-based line number in each version that
 *  contains it. */
export type Provenance = Partial<DiamondT<number>>;

/** The innermost 2-way range a rendered line belongs to; a ddiff line keeps
 *  the kind of the inner diff line it displays, since the inner sign is the
 *  one that reads as added/removed. Undefined for decoration: headers, hints,
 *  and grouping pipes. */
export type LineKind = "same" | "prev" | "next" | "unified";

/** One rendered display line with its provenance in the four versions. Hunk
 *  headers carry their hunk's start lines as an anchor; other decoration
 *  carries an empty provenance. */
export type Line = {
  readonly text: string;
  readonly kind: LineKind | undefined;
  readonly provenance: Provenance;
};

export type Block = {
  readonly hint: readonly string[];
  readonly lines: readonly Line[];
};

export type View = {
  readonly id: Id;
  readonly blocks: readonly Block[];
};

export type AlgoArgs = {
  readonly includeHunkBreaks: boolean;
  readonly diff4Class: Diff4Class.Diff4Class;
  readonly context: number;
  readonly output: Header.Output4;
  readonly slices: DiamondT<Slice.Slice>;
};

export type DiffAlgo = {
  readonly id: Id;
  readonly apply: (args: AlgoArgs) => View;
};

/** A change of one slice of lines to another; often all a view needs to show
 *  in place of a full 4-way diff. */
type Change = {
  readonly from: Slice.Slice;
  readonly to: Slice.Slice;
};

const headerOfChange = (args: {
  diff4Class: Diff4Class.Diff4Class;
  fullDiff: DiamondT<Slice.Slice>;
  from: Node;
  to: Node;
}): Header.Diff2 => {
  const names = Diamond.map(args.fullDiff, (slice) => slice.range.source);
  const groupBy = Diamond.group(names, args.diff4Class);
  return {
    minus: Range.toHeader(Diamond.get(args.fullDiff, args.from).range, Diamond.get(groupBy, args.from)),
    plus: Range.toHeader(Diamond.get(args.fullDiff, args.to).range, Diamond.get(groupBy, args.to)),
  };
};

/** A rendered line of one 2-way diff, with 1-based line numbers into the
 *  change's from/to sources where its content exists. */
type Diff2Line = {
  readonly text: string;
  readonly kind: LineKind | undefined;
  readonly from: number | undefined;
  readonly to: number | undefined;
};

const diffOfChange = (args: {
  refined?: boolean;
  produceUnifiedLines?: boolean;
  formatRules?: Format.Rules;
  includeHunkBreaks: boolean;
  header: Header.Header;
  context: number;
  output: Header.Output4;
  change: Change;
}): Diff2Line[] => {
  const refined = args.refined ?? true;
  const rules = args.formatRules ?? FormatRules.innerDefault;
  // Unified lines are unsupported in Ascii output.
  const produceUnifiedLines = (args.produceUnifiedLines ?? true) && args.output === "Ansi";
  const diffed = withoutUnix.diff({
    context: args.context,
    lineBigEnough: defaultLineBigEnough,
    keepWs: false,
    findMoves: false,
    prev: args.change.from.lines,
    next: args.change.to.lines,
  });
  const hunks = refined
    ? withoutUnix.refine({
        rules,
        produceUnifiedLines,
        output: args.output,
        keepWs: false,
        splitLongLines: false,
        interleave: true,
        wordBigEnough: defaultWordBigEnough,
        hunks: diffed,
      })
    : PatienceHunks.unified(diffed);
  const blocks = withoutUnix.buildUnified({ rules, output: args.output, hunks });
  // Hunk starts are 1-based within the slices, so slice starts convert them
  // (and every position walked from them) straight to 1-based file lines.
  const fromStart = args.change.from.range.lineStart;
  const toStart = args.change.to.range.lineStart;
  const lines: Diff2Line[] = [];
  hunks.forEach((hunk, i) => {
    if (args.includeHunkBreaks) {
      const header = Header.addHunkBreak(args.header, [hunk.prevStart, hunk.prevSize], [hunk.nextStart, hunk.nextSize]);
      for (const text of Header.toString(args.output, header)) {
        lines.push({ text, kind: undefined, from: fromStart + hunk.prevStart, to: toStart + hunk.nextStart });
      }
    }
    // Walk the hunk's ranges in the order buildUnified renders them, pairing
    // each display line with its position in the from/to sources. Moves never
    // appear (findMoves is off above), so every range consumes positions by
    // its plain size.
    const meta: Omit<Diff2Line, "text">[] = [];
    let from = fromStart + hunk.prevStart;
    let to = toStart + hunk.nextStart;
    for (const range of hunk.ranges) {
      switch (range.kind) {
        case "same":
          for (let k = 0; k < range.contents.length; k++) meta.push({ kind: "same", from: from++, to: to++ });
          break;
        case "prev":
          for (let k = 0; k < range.contents.length; k++) meta.push({ kind: "prev", from: from++, to: undefined });
          break;
        case "next":
          for (let k = 0; k < range.contents.length; k++) meta.push({ kind: "next", from: undefined, to: to++ });
          break;
        case "unified":
          for (let k = 0; k < range.contents.length; k++) meta.push({ kind: "unified", from: from++, to: to++ });
          break;
        case "replace":
          for (let k = 0; k < range.prev.length; k++) meta.push({ kind: "prev", from: from++, to: undefined });
          for (let k = 0; k < range.next.length; k++) meta.push({ kind: "next", from: undefined, to: to++ });
          break;
      }
    }
    const rendered = blocks[i];
    if (rendered === undefined || rendered.length !== meta.length) {
      throw new Error(`patdiff4 rendered ${rendered?.length ?? 0} lines for a hunk of ${meta.length}`);
    }
    rendered.forEach((text, j) => {
      const at = meta[j];
      if (at === undefined) throw new Error(`patdiff4 hunk position ${j} out of ${meta.length} missing`);
      lines.push({ ...at, text: text.replace(/\s+$/, "") });
    });
  });
  return lines;
};

/** Provenance from per-node line numbers, keeping only the known ones. */
const provenance = (at: readonly (readonly [Node, number | undefined])[]): Provenance => {
  const result: { [K in Node]?: number } = {};
  for (const [node, line] of at) {
    if (line !== undefined) result[node] = line;
  }
  return result;
};

const threeWayDiff = (args: { oldBase: Slice.Slice; newBase: Slice.Slice; oldTip: Slice.Slice }): readonly string[] => [
  `<<<<<<< ${args.oldTip.range.source}`,
  ...args.oldTip.lines,
  `||||||| ${args.oldBase.range.source}`,
  ...args.oldBase.lines,
  "=======",
  ...args.newBase.lines,
  `>>>>>>> ${args.newBase.range.source}`,
];

/** Render the hunk as a 3-way merge with conflict markers, diffed against the
 *  new tip: how the author resolved the conflict. */
const conflictResolution: DiffAlgo = {
  id: "conflict_resolution",
  apply: ({ includeHunkBreaks, context, output, slices }) => {
    const { b1: oldBase, b2: newBase, f1: oldTip, f2: newTip } = slices;
    const conflictLines = threeWayDiff({ oldBase, newBase, oldTip });
    const change: Change = {
      from: {
        lines: conflictLines,
        // The range is unused by the diff; only the source shows in errors.
        range: {
          source: `3way diff of ${oldBase.range.source}, ${newBase.range.source}, and ${oldTip.range.source}`,
          lineStart: 0,
          lineEnd: conflictLines.length,
        },
      },
      to: newTip,
    };
    const header: Header.Header = {
      kind: "Diff2",
      diff: {
        minus: { name: "conflict", otherNames: [], range: undefined },
        plus: Range.toHeader(newTip.range, []),
      },
    };
    // The from side is the synthetic conflict text, which lives in no file.
    const lines = diffOfChange({ includeHunkBreaks, header, context, output, change }).map(
      (line): Line => ({ text: line.text, kind: line.kind, provenance: provenance([["f2", line.to]]) }),
    );
    return { id: "conflict_resolution", blocks: [{ hint: [], lines }] };
  },
};

const makeDdiffAlgo = (args: { id: "base_ddiff" | "feature_ddiff"; hints?: readonly HintKey[] }): DiffAlgo => {
  const [from, to]: readonly [readonly [Node, Node], readonly [Node, Node]] =
    args.id === "base_ddiff"
      ? [
          ["b1", "b2"],
          ["f1", "f2"],
        ]
      : [
          ["b1", "f1"],
          ["b2", "f2"],
        ];
  return {
    id: args.id,
    apply: ({ includeHunkBreaks, diff4Class, context, output, slices }) => {
      const change = (nodes: readonly [Node, Node]): Change => ({
        from: Diamond.get(slices, nodes[0]),
        to: Diamond.get(slices, nodes[1]),
      });
      const aHeader = headerOfChange({ diff4Class, fullDiff: slices, from: from[0], to: from[1] });
      const bHeader = headerOfChange({ diff4Class, fullDiff: slices, from: to[0], to: to[1] });
      const innerDiff = (withHunkBreaks: boolean, header: Header.Diff2, nodes: readonly [Node, Node]): Line[] =>
        diffOfChange({
          includeHunkBreaks: withHunkBreaks,
          header: { kind: "Diff2", diff: header },
          context: withHunkBreaks ? context : infiniteContext,
          output,
          change: change(nodes),
        }).map((line) => ({
          text: line.text,
          kind: line.kind,
          provenance: provenance([
            [nodes[0], line.from],
            [nodes[1], line.to],
          ]),
        }));
      // Heuristic: when the ddiff is essentially a diff (one side empty), keep
      // the hunk breaks on the inner level; otherwise use full inner context
      // so the outer diff aligns whole inner diffs.
      const aWithBreaks = innerDiff(true, aHeader, from);
      const bWithBreaks = innerDiff(true, bHeader, to);
      const [aInner, bInner] =
        aWithBreaks.length === 0 || bWithBreaks.length === 0
          ? [aWithBreaks, bWithBreaks]
          : [innerDiff(false, aHeader, from), innerDiff(false, bHeader, to)];
      const outer = diffOfChange({
        refined: false,
        produceUnifiedLines: false,
        formatRules: FormatRules.outerDefault,
        includeHunkBreaks,
        header: { kind: "Diff4", diff: { minus: aHeader, plus: bHeader } },
        context,
        output,
        change: {
          from: Slice.create(
            "",
            0,
            aInner.map((line) => line.text),
          ),
          to: Slice.create(
            "",
            0,
            bInner.map((line) => line.text),
          ),
        },
      });
      // The outer diff's positions index the inner renders, so each outer
      // line inherits the provenance of the inner line(s) it displays. Outer
      // headers anchor past an inner render's end when a hunk is empty on one
      // side; they just get no provenance from that side.
      const lines = outer.map((line): Line => {
        const a = line.from === undefined ? undefined : aInner[line.from - 1];
        const b = line.to === undefined ? undefined : bInner[line.to - 1];
        return {
          text: line.text,
          kind: line.kind === undefined ? undefined : (a ?? b)?.kind,
          provenance: { ...a?.provenance, ...b?.provenance },
        };
      });
      const hint = (args.hints ?? []).map((key) => renderHint(output, key));
      return { id: args.id, blocks: [{ hint, lines }] };
    },
  };
};

type HintKey = {
  [K in keyof typeof Header.hint]: (typeof Header.hint)[K] extends string ? K : never;
}[keyof typeof Header.hint];

const renderHint = (output: Header.Output4, key: HintKey): string => Header.renderHint(output, Header.hint[key]);

const buildDiffLines = (
  elements: readonly [Node, Node],
  { includeHunkBreaks, diff4Class, context, output, slices }: AlgoArgs,
): Line[] => {
  const [from, to] = elements;
  const header = headerOfChange({ diff4Class, fullDiff: slices, from, to });
  return diffOfChange({
    includeHunkBreaks,
    header: { kind: "Diff2", diff: header },
    context,
    output,
    change: { from: Diamond.get(slices, from), to: Diamond.get(slices, to) },
  }).map((line) => ({
    text: line.text,
    kind: line.kind,
    provenance: provenance([
      [from, line.from],
      [to, line.to],
    ]),
  }));
};

const buildDiffAlgo = (elements: readonly [Node, Node], hints?: readonly HintKey[]): DiffAlgo => {
  const id = DiffAlgoId.simpleDiff(elements[0], elements[1]);
  return {
    id,
    apply: (args) => ({
      id,
      blocks: [
        {
          hint: (hints ?? []).map((key) => renderHint(args.output, key)),
          lines: buildDiffLines(elements, args),
        },
      ],
    }),
  };
};

const newBaseToNewTip = (hints?: readonly HintKey[]): DiffAlgo => buildDiffAlgo(["b2", "f2"], hints);
const oldBaseToOldTip = (hints?: readonly HintKey[]): DiffAlgo => buildDiffAlgo(["b1", "f1"], hints);
const oldBaseToNewBase = (hints?: readonly HintKey[]): DiffAlgo => buildDiffAlgo(["b1", "b2"], hints);
const oldBaseToNewTip = (hints?: readonly HintKey[]): DiffAlgo => buildDiffAlgo(["b1", "f2"], hints);
const oldTipToNewTip = (hints?: readonly HintKey[]): DiffAlgo => buildDiffAlgo(["f1", "f2"], hints);

const story = (args: {
  droppedHint: string;
  droppedElements: readonly [Node, Node];
  inFavorHint: string;
  inFavorElements: readonly [Node, Node];
}): DiffAlgo => ({
  id: "story",
  apply: (algoArgs) => ({
    id: "story",
    blocks: [
      {
        hint: [Header.renderHint(algoArgs.output, args.droppedHint)],
        lines: buildDiffLines(args.droppedElements, algoArgs),
      },
      {
        hint: [Header.renderHint(algoArgs.output, args.inFavorHint)],
        lines: buildDiffLines(args.inFavorElements, algoArgs),
      },
    ],
  }),
});

type ShownAsDiff2 = "b1_b2_f1" | "b1_b2_f2" | "b1_b2" | "b1_f1_f2" | "b2_f1" | "b1_f2__b2_f1";

const shownAsDiff2 = (t: Diff4Class.ShownClass): t is ShownAsDiff2 => {
  switch (t) {
    case "b1_b2_f1":
    case "b1_b2_f2":
    case "b1_b2":
    case "b1_f1_f2":
    case "b2_f1":
    case "b1_f2__b2_f1":
      return true;
    default:
      return false;
  }
};

/** Whether a whole file of this class needs 4-way alignment into segments, or
 *  can be shown as one plain 2-way diff. */
export const shouldSplitFilesInHunks = (diff4Class: Diff4Class.Diff4Class): boolean => {
  const shown = Diff4Class.shownClassOf(diff4Class);
  if (shown === undefined) return false;
  return !shownAsDiff2(shown);
};

const allStandardViews: readonly DiffAlgo[] = [
  makeDdiffAlgo({ id: "feature_ddiff" }),
  makeDdiffAlgo({ id: "base_ddiff" }),
  oldTipToNewTip(),
  newBaseToNewTip(),
  oldBaseToOldTip(),
  oldBaseToNewBase(),
  oldBaseToNewTip(),
  conflictResolution,
];

export const selectAlgosForReview = (shownClass: Diff4Class.ShownClass): readonly DiffAlgo[] => {
  if (shownAsDiff2(shownClass)) {
    switch (shownClass) {
      case "b1_b2_f1":
        return [newBaseToNewTip()];
      case "b1_b2_f2":
        return [oldTipToNewTip(["b1_b2_f2"])];
      case "b1_b2":
        return [oldTipToNewTip()];
      case "b1_f1_f2":
        return [newBaseToNewTip(["b1_f1_f2"])];
      case "b2_f1":
        return [newBaseToNewTip()];
      case "b1_f2__b2_f1":
        return [newBaseToNewTip(["b1_f2__b2_f1"])];
    }
  }
  switch (shownClass) {
    case "b1_f1":
      return [newBaseToNewTip()];
    case "b1_f2":
      return [
        makeDdiffAlgo({ id: "feature_ddiff", hints: ["b1_f2"] }),
        makeDdiffAlgo({ id: "base_ddiff", hints: ["b1_f2"] }),
        oldTipToNewTip(["b1_f2"]),
        newBaseToNewTip(["b1_f2"]),
      ];
    case "b2_f2":
      return [
        makeDdiffAlgo({ id: "feature_ddiff", hints: ["b2_f2"] }),
        oldBaseToNewBase(["b2_f2", "b2_f2_kept"]),
        story({
          droppedHint: Header.hint.b2_f2_story[0],
          droppedElements: ["b1", "f1"],
          inFavorHint: Header.hint.b2_f2_story[1],
          inFavorElements: ["b1", "b2"],
        }),
        oldTipToNewTip(["b2_f2"]),
        makeDdiffAlgo({ id: "base_ddiff", hints: ["b2_f2"] }),
        oldBaseToOldTip(["b2_f2", "b2_f2_dropped"]),
      ];
    case "f1_f2":
      return [
        makeDdiffAlgo({ id: "feature_ddiff", hints: ["f1_f2"] }),
        newBaseToNewTip(["f1_f2", "f1_f2_kept"]),
        story({
          droppedHint: Header.hint.f1_f2_story[0],
          droppedElements: ["b1", "b2"],
          inFavorHint: Header.hint.f1_f2_story[1],
          inFavorElements: ["b1", "f2"],
        }),
        makeDdiffAlgo({ id: "base_ddiff", hints: ["f1_f2"] }),
        oldBaseToNewBase(["f1_f2", "f1_f2_dropped"]),
      ];
    case "conflict":
      return allStandardViews;
  }
};

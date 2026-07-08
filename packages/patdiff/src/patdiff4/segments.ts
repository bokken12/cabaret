/** The 4-way alignment at the heart of patdiff4, ported from Iron's
 *  [patdiff4/lib/segments.ml].
 *
 *  Two patience diffs (b1↔f1 and b2↔f2) each yield the lines they matched;
 *  diffing those two matched-line sequences against each other anchors line
 *  numbers in all four files at once. The files are then cut at the anchors
 *  into segments, each classified by which of its four slices are equal. */

import * as Format from "../kernel/format.js";
import { defaultLineBigEnough, defaultWordBigEnough, removeWs, withoutUnix } from "../kernel/patdiff-core.js";
import { String as PatienceString } from "../patience-diff/patience-diff.js";
import { iterMatches } from "../patience-diff/plain-diff.js";
import { splitLines } from "../shared/string-util.js";
import type { Diamond as DiamondT } from "./diamond.js";
import * as Diamond from "./diamond.js";
import { shouldSplitFilesInHunks } from "./diff-algo.js";
import * as Diff4Class from "./diff4-class.js";
import * as Range from "./range.js";
import type { Segment } from "./segment.js";
import * as SegmentM from "./segment.js";
import * as Slice from "./slice.js";

/** The last `n` elements. */
const tail = <A>(list: readonly A[], n: number): readonly A[] =>
  n <= 0 ? [] : list.slice(Math.max(0, list.length - n));

/** The first `n` elements. */
const head = <A>(list: readonly A[], n: number): readonly A[] => (n <= 0 ? [] : list.slice(0, n));

/** The lines' whitespace-stripped concatenation. The classification pipeline
 *  ignores whitespace at every level — line matching and word refinement both
 *  compare through [removeWs] — so it can only ever show differences between
 *  these characters: unequal projections prove inequality without diffing.
 *  Stripping distributes over concatenation, so the merge loop below can
 *  maintain the projection incrementally instead of rescanning accumulated
 *  slices. */
const stripAllWs = (lines: readonly string[]): string => {
  const parts: string[] = [];
  for (const line of lines) parts.push(line.replace(/[ \t\r\n]+/g, ""));
  return parts.join("");
};

/** Line-by-line equality under the diff's whitespace normalization. Equal
 *  normalized sequences diff to all-Same ranges, which refine drops, so this
 *  implies pipeline equality without running it. */
const equalModuloWs = (lines1: readonly string[], lines2: readonly string[]): boolean => {
  if (lines1.length !== lines2.length) return false;
  for (let i = 0; i < lines1.length; i++) {
    const a = lines1[i]!;
    const b = lines2[i]!;
    if (a !== b && removeWs(a) !== removeWs(b)) return false;
  }
  return true;
};

/** A slice's lines paired with their [stripAllWs] projection. */
type ClassifyInput = { readonly lines: readonly string[]; readonly stripped: string };

/** Equality modulo whitespace: two slices classify as equal when patdiff
 *  finds nothing to show between them. The projection and line pre-checks
 *  decide most pairs; the full diff+refine pipeline is the last resort. */
const equalForClassify = (a: ClassifyInput, b: ClassifyInput): boolean => {
  if (a.stripped !== b.stripped) return false;
  if (equalModuloWs(a.lines, b.lines)) return true;
  const hunks = withoutUnix.diff({
    context: 0,
    lineBigEnough: defaultLineBigEnough,
    keepWs: false,
    findMoves: false,
    prev: a.lines,
    next: b.lines,
  });
  const refined = withoutUnix.refine({
    rules: Format.Rules.defaultRules,
    produceUnifiedLines: true,
    output: "Ansi",
    keepWs: false,
    splitLongLines: false,
    interleave: true,
    wordBigEnough: defaultWordBigEnough,
    hunks,
  });
  return refined.length === 0;
};

const classifyStripped = (slice: DiamondT<Slice.Slice>, stripped: DiamondT<string>): Diff4Class.Diff4Class =>
  Diamond.classify(
    equalForClassify,
    Diamond.map2(slice, stripped, (s, st): ClassifyInput => ({ lines: s.lines, stripped: st })),
  );

const splitAround = <A>(list: readonly A[], n: number): readonly [readonly A[], A, readonly A[]] => {
  const at = Math.max(0, n);
  const mid = list[at];
  if (mid === undefined) {
    throw new Error(`splitAround: index ${at} out of bounds (length ${list.length})`);
  }
  return [list.slice(0, at), mid, list.slice(at + 1)];
};

const ofMatches = (args: {
  fileNames: DiamondT<string>;
  context: number;
  linesRequiredToSeparateDdiffHunks: number;
  diamond: DiamondT<readonly string[]>;
  matches: readonly DiamondT<number>[];
}): Segment[] => {
  const { fileNames, context, linesRequiredToSeparateDdiffHunks, diamond, matches } = args;
  const segments: Segment[] = [];
  // The pending segment and the last raw segment merged into it, each paired
  // with the stripped projection of its slices so merged classifications
  // need not rescan the accumulated lines.
  type Pending = {
    readonly seg: Segment;
    readonly segStripped: DiamondT<string>;
    readonly last: Segment;
    readonly lastStripped: DiamondT<string>;
  };
  let current: Pending | undefined;
  let currentRevCommon: string[] = [];

  const enqueueSegment = (segment: Segment, stripped: DiamondT<string>): void => {
    if (current === undefined) {
      const preCommon = tail(currentRevCommon, context);
      currentRevCommon = [];
      const preStripped = stripAllWs(preCommon);
      current = {
        seg: SegmentM.prepend(preCommon, segment),
        segStripped: Diamond.map(stripped, (s) => preStripped + s),
        last: segment,
        lastStripped: stripped,
      };
      return;
    }
    const { seg: seg1, segStripped: seg1Stripped, last: lastOfSeg1, lastStripped } = current;
    const seg2 = segment;
    const contextBetween = currentRevCommon;
    currentRevCommon = [];
    const contextStripped = stripAllWs(contextBetween);
    const diff4ClassOfLastTwo = (): Diff4Class.Diff4Class => {
      if (lastOfSeg1.diff4Class === seg2.diff4Class) return lastOfSeg1.diff4Class;
      return Diamond.classify(
        equalForClassify,
        Diamond.init(
          (node): ClassifyInput => ({
            lines: [
              ...Diamond.get(lastOfSeg1.slice, node).lines,
              ...contextBetween,
              ...Diamond.get(seg2.slice, node).lines,
            ],
            stripped: Diamond.get(lastStripped, node) + contextStripped + Diamond.get(stripped, node),
          }),
        ),
      );
    };
    // Either merge the segments or separate them, distributing the common
    // lines between them as context.
    if (
      (contextBetween.length <= context * 2 && (SegmentM.isShown(lastOfSeg1) || SegmentM.isShown(seg2))) ||
      (contextBetween.length < linesRequiredToSeparateDdiffHunks &&
        (SegmentM.isShown(lastOfSeg1) || SegmentM.isShown(seg2) || Diff4Class.isShown(diff4ClassOfLastTwo())))
    ) {
      const slice = Diamond.map2(seg1.slice, seg2.slice, (sl1, sl2) => ({
        range: Range.merge(sl1.range, sl2.range),
        lines: [...sl1.lines, ...contextBetween, ...sl2.lines],
      }));
      const mergedStripped = Diamond.map2(seg1Stripped, stripped, (s1, s2) => s1 + contextStripped + s2);
      const diff4Class =
        seg1.diff4Class === seg2.diff4Class ? seg1.diff4Class : classifyStripped(slice, mergedStripped);
      current = { seg: { slice, diff4Class }, segStripped: mergedStripped, last: seg2, lastStripped: stripped };
    } else {
      const splitAt = Math.min(context, Math.floor(contextBetween.length / 2));
      if (SegmentM.isShown(seg1)) {
        const splitSeg1 = SegmentM.isShown(seg2) ? splitAt : context;
        segments.push(SegmentM.append(seg1, head(contextBetween, splitSeg1)));
      }
      const splitSeg2 = SegmentM.isShown(seg1) ? splitAt : context;
      const preCommon = tail(contextBetween, splitSeg2);
      const preStripped = stripAllWs(preCommon);
      current = {
        seg: SegmentM.prepend(preCommon, seg2),
        segStripped: Diamond.map(stripped, (s) => preStripped + s),
        last: seg2,
        lastStripped: stripped,
      };
    }
  };

  const finalize = (): Segment[] => {
    if (current !== undefined) {
      const { seg: segment } = current;
      if (SegmentM.isShown(segment)) {
        const postCommon = head(currentRevCommon, context);
        segments.push(SegmentM.append(segment, postCommon));
      }
    }
    current = undefined;
    currentRevCommon = [];
    return segments;
  };

  const enqueueSourceLines = (matchLines: DiamondT<number>, sourceLines: DiamondT<readonly string[]>): void => {
    if (Diamond.forAll(sourceLines, (lines) => lines.length === 0)) return;
    const slice = Diamond.map3(fileNames, matchLines, sourceLines, (source, line, lines) =>
      Slice.create(source, line, lines),
    );
    const stripped = Diamond.map(slice, (s) => stripAllWs(s.lines));
    enqueueSegment({ slice, diff4Class: classifyStripped(slice, stripped) }, stripped);
  };

  let matchLines = Diamond.singleton(0);
  let sourceLines = diamond;
  for (const match of matches) {
    // Grab the actual lines from matching line numbers.
    const split = Diamond.map3(sourceLines, match, matchLines, (lines, matchAt, lineAt) =>
      splitAround(lines, matchAt - lineAt),
    );
    const prevLines = Diamond.map(split, ([prev]) => prev);
    const mid = Diamond.map(split, ([, m]) => m);
    const nextLines = Diamond.map(split, ([, , next]) => next);
    if (!Diamond.forAll(mid, (line) => line === mid.b1)) {
      throw new Error(`patdiff4 alignment anchored on unequal lines: ${JSON.stringify(mid)}`);
    }
    enqueueSourceLines(matchLines, prevLines);
    currentRevCommon.push(mid.b1);
    matchLines = Diamond.map(match, (m) => m + 1);
    sourceLines = nextLines;
  }
  enqueueSourceLines(matchLines, sourceLines);
  return finalize();
};

/** The common subsequence of two line sequences, as index pairs. Patience
 *  common subsequence would also work, but plain diff is O(ND) in the size of
 *  the diff where longest common subsequence is O(N^2). */
const diffCommonSequence = (a: readonly string[], b: readonly string[]): [number, number][] => {
  const matches: [number, number][] = [];
  iterMatches<string>({ a, b, hash: (s) => s, f: (pair) => matches.push(pair) });
  return matches;
};

export const ofFiles = (args: {
  revNames: DiamondT<string>;
  context: number;
  linesRequiredToSeparateDdiffHunks: number;
  contents: DiamondT<string>;
  forceShouldSplitFilesInHunksForTests?: boolean;
}): Segment[] => {
  const { revNames, context, linesRequiredToSeparateDdiffHunks, contents } = args;
  const fileNames = Diamond.prettyShortRevNames((a, b) => a === b, revNames);
  const lines = Diamond.map(contents, splitLines);

  const filesDiff4Class = Diamond.classify(
    (a: readonly [string, ClassifyInput], b: readonly [string, ClassifyInput]) =>
      a[0] === b[0] || equalForClassify(a[1], b[1]),
    Diamond.map2(
      revNames,
      lines,
      (rev, fileLines) => [rev, { lines: fileLines, stripped: stripAllWs(fileLines) }] as const,
    ),
  );

  if (!(shouldSplitFilesInHunks(filesDiff4Class) || (args.forceShouldSplitFilesInHunksForTests ?? false))) {
    return [
      {
        slice: Diamond.map2(fileNames, lines, (source, fileLines) => Slice.create(source, 0, fileLines)),
        diff4Class: filesDiff4Class,
      },
    ];
  }

  // PCS = "patience common subsequence": the lines each 2-way diff matched,
  // with their line numbers in both files.
  const pcs = (aLines: readonly string[], bLines: readonly string[]): readonly [string, number, number][] =>
    PatienceString.matches(aLines, bLines).map(([idxA, idxB]) => {
      const line = aLines[idxA];
      if (line === undefined || line !== bLines[idxB]) {
        throw new Error("patience diff matched unequal lines");
      }
      return [line, idxA, idxB] as const;
    });

  const pcsOldBaseOldTip = pcs(lines.b1, lines.f1);
  const pcsNewBaseNewTip = pcs(lines.b2, lines.f2);

  const matches = diffCommonSequence(
    pcsOldBaseOldTip.map(([line]) => line),
    pcsNewBaseNewTip.map(([line]) => line),
  );

  const indexesOfMatches = matches.map(([oldIdx, newIdx]) => {
    const [, oldBaseIdx, oldTipIdx] = pcsOldBaseOldTip[oldIdx] as readonly [string, number, number];
    const [, newBaseIdx, newTipIdx] = pcsNewBaseNewTip[newIdx] as readonly [string, number, number];
    return { b1: oldBaseIdx, b2: newBaseIdx, f1: oldTipIdx, f2: newTipIdx };
  });

  return ofMatches({
    fileNames,
    context,
    linesRequiredToSeparateDdiffHunks,
    diamond: lines,
    matches: indexesOfMatches,
  });
};

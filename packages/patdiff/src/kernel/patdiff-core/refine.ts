/** Word-level refinement of replace ranges. Mirrors OCaml's [refine] and
 *  [refine_structured]. */

import type { Hunk } from "../../patience-diff/hunk.js";
import type { MoveId } from "../../patience-diff/move-id.js";
import * as PatienceDiff from "../../patience-diff/patience-diff.js";
import { Range } from "../../patience-diff/range.js";
import { tooShortToSplit } from "../configuration.js";
import type * as Format from "../format.js";
import type { Hunks } from "../hunks.js";
import type { Output, S as OutputS } from "../output.js";
import type { StructuredHunks, StructuredLine } from "../patdiff-core-types.js";
import { explodeInternal, type WordOrNewline } from "./explode.js";
import { isWs, removeWs, split, whitespaceIgnorantSplit } from "./word-split.js";

const DEFAULT_REFINE_LINE_LENGTH = 78;

/** Tag for [`Same | `Prev | `Next] used by [collapse_structured]. */
type Tag = "Same" | "Prev" | "Next";

type CollapseKind = "PrevOnly" | "NextOnly" | "Unified";

const tagPair = (tag: Tag, s: string): StructuredLine => [tag, s] as const;

const newlineToken = (): WordOrNewline => ({
  kind: "newline",
  count: 1,
  trailer: undefined,
});

/** Collapse the pieces back into lines, returning structured tagged segments per line.
 *  Mirrors OCaml's [collapse_structured]. */
const collapseStructured = (
  ranges: readonly Range<WordOrNewline>[],
  kind: CollapseKind,
): readonly StructuredLine[][] => {
  let flag: Tag = "Same";
  let segment: string[] = [];
  let line: StructuredLine[] = [];
  const lines: StructuredLine[][] = [];

  const finishSegment = (): void => {
    const text = segment.join("");
    line.push([flag, text]);
    segment = [];
  };

  const newline = (i: number): void => {
    for (let k = 0; k < i; k++) {
      finishSegment();
      lines.push(line);
      line = [];
    }
  };

  const project = (range: Range<WordOrNewline>): readonly WordOrNewline[] => {
    switch (range.kind) {
      case "same": {
        flag = "Same";
        if (kind === "PrevOnly") {
          return range.contents.map(([prev]) => prev);
        }
        return range.contents.map(([, next]) => next);
      }
      case "prev":
        flag = "Prev";
        return range.contents;
      case "next":
        flag = "Next";
        return range.contents;
      case "replace":
      case "unified":
        throw new Error("collapseStructured: unexpected Replace/Unified");
    }
  };

  for (const range of ranges) {
    const arr = project(range);
    for (const tok of arr) {
      if (tok.kind === "newline") {
        newline(tok.count);
        if (tok.trailer !== undefined) segment.push(tok.trailer);
      } else {
        segment.push(tok.value);
      }
    }
    finishSegment();
  }

  // Trailing line check: OCaml drops empty trailing lines, and raises on non-newline-
  // terminated text. We mirror that, dropping silently in the whitespace-only case.
  if (line.length === 0) {
    // nothing
  } else if (line.length === 1 && line[0]![1] === "") {
    // nothing
  } else {
    const concat = line.map(([, s]) => s).join("");
    if (!isWs(concat)) {
      throw new Error("Invariant violated: [collapse] got a line not terminated with a newline");
    }
  }
  return lines;
};

/** Collapse the pieces back into lines, applying rule-based formatting. Mirrors OCaml's
 *  [collapse]. */
const collapseStrings = (args: {
  readonly ranges: readonly Range<WordOrNewline>[];
  readonly ruleSame: Format.Rule;
  readonly rulePrev: Format.Rule;
  readonly ruleNext: Format.Rule;
  readonly kind: CollapseKind;
  readonly outputImpl: OutputS;
}): readonly string[] => {
  const { ranges, ruleSame, rulePrev, ruleNext, kind, outputImpl } = args;
  const structured = collapseStructured(ranges, kind);
  const apply = (rule: Format.Rule, word: string): string =>
    word === "" ? "" : outputImpl.applyRule(word, { rule, refined: false });
  return structured.map((line) =>
    line
      .map(([tag, word]) => {
        switch (tag) {
          case "Same":
            return apply(ruleSame, word);
          case "Prev":
            return apply(rulePrev, word);
          case "Next":
            return apply(ruleNext, word);
        }
      })
      .join(""),
  );
};

/** Get word-level hunks for two arrays of [WordOrNewline] tokens. Mirrors OCaml's
 *  [diff_pieces]. */
const diffPieces = (args: {
  readonly prevPieces: readonly WordOrNewline[];
  readonly nextPieces: readonly WordOrNewline[];
  readonly keepWs: boolean;
  readonly wordBigEnough: number;
}): Hunk<WordOrNewline>[] => {
  const { prevPieces, nextPieces, keepWs, wordBigEnough } = args;
  const transform = keepWs
    ? (t: WordOrNewline): string => {
        if (t.kind === "word") return t.value;
        const base = "\n".repeat(t.count);
        return t.trailer === undefined ? base : base + t.trailer;
      }
    : (t: WordOrNewline): string => {
        if (t.kind === "word") return removeWs(t.value);
        if (t.count === 0) return "";
        return " ";
      };
  return PatienceDiff.make<string>({
    compare: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
    hash: (x) => x,
  }).getHunks<WordOrNewline>({
    transform,
    context: -1,
    bigEnough: wordBigEnough,
    maxSlide: 0,
    prev: prevPieces,
    next: nextPieces,
  });
};

const rangesAreJustWhitespace = (ranges: readonly Range<WordOrNewline>[]): boolean => {
  for (const r of ranges) {
    if (r.kind === "prev" || r.kind === "next") {
      for (const t of r.contents) {
        if (t.kind === "word" && removeWs(t.value).length > 0) return false;
      }
    }
  }
  return true;
};

/** Mirrors OCaml's [split_for_readability]. */
const splitForReadability = (rangelist: readonly Range<WordOrNewline>[]): Range<WordOrNewline>[][] => {
  const ans: Range<WordOrNewline>[][] = [];
  let pending: Range<WordOrNewline>[] = [];
  const appendRange = (r: Range<WordOrNewline>): void => {
    pending.push(r);
  };
  for (const range of rangelist) {
    let splitWasExecuted = false;
    if (range.kind === "same") {
      const seq = range.contents;
      let firstNewline: readonly [number, WordOrNewline, WordOrNewline] | undefined;
      for (let i = 0; i < seq.length; i++) {
        const [a, b] = seq[i]!;
        const aIsNl = a.kind === "newline" && a.count > 0;
        const bIsNl = b.kind === "newline" && b.count > 0;
        if (aIsNl && bIsNl) {
          firstNewline = [i, a, b];
          break;
        }
      }
      if (firstNewline !== undefined) {
        const [i, firstNlA, firstNlB] = firstNewline;
        if (seq.length - i > tooShortToSplit) {
          appendRange(Range.same(seq.slice(0, i)));
          appendRange(Range.same([[newlineToken(), newlineToken()] as const]));
          ans.push(pending);
          pending = [];
          const suf = seq.slice(i);
          const decrFirst = (x: WordOrNewline): WordOrNewline =>
            x.kind === "newline" ? { ...x, count: x.count - 1 } : x;
          const firstPair: readonly [WordOrNewline, WordOrNewline] = [
            decrFirst(firstNlA),
            decrFirst(firstNlB),
          ] as const;
          const sufNew: Array<readonly [WordOrNewline, WordOrNewline]> = [firstPair, ...suf.slice(1)];
          appendRange(Range.same(sufNew));
          splitWasExecuted = true;
        }
      }
    }
    if (!splitWasExecuted) appendRange(range);
  }
  if (pending.length > 0) ans.push(pending);
  return ans;
};

/** Mirrors OCaml's [words_break_hueristic] (sic). */
const wordsBreakHeuristic = (
  prevAr: readonly string[],
  nextAr: readonly string[],
  keepWs: boolean,
): Array<readonly [readonly (readonly string[])[], readonly (readonly string[])[]]> => {
  const TARGET_BLOCK_SIZE = 100;
  const targetNumBlocks = Math.trunc(Math.min(prevAr.length, nextAr.length) / TARGET_BLOCK_SIZE);
  const tokenize = (s: string): readonly string[] => (keepWs ? split(s, true) : whitespaceIgnorantSplit(s));
  const prevWords = prevAr.map(tokenize);
  const nextWords = nextAr.map(tokenize);
  if (prevWords.length < TARGET_BLOCK_SIZE * 2 && nextWords.length < TARGET_BLOCK_SIZE) {
    return [[prevWords, nextWords] as const];
  }
  const wordFreq = new Map<string, [number, number]>();
  for (const line of prevWords) {
    for (const word of line) {
      const cur = wordFreq.get(word);
      if (cur === undefined) wordFreq.set(word, [1, 0]);
      else cur[0] += 1;
    }
  }
  for (const line of nextWords) {
    for (const word of line) {
      const cur = wordFreq.get(word);
      if (cur === undefined) wordFreq.set(word, [0, 1]);
      else cur[1] += 1;
    }
  }
  const prevWordCount = prevWords.reduce((s, l) => s + l.length, 0);
  const nextWordCount = nextWords.reduce((s, l) => s + l.length, 0);
  const prevFreqCutoff = Math.trunc(Math.sqrt(prevWordCount));
  const nextFreqCutoff = Math.trunc(Math.sqrt(nextWordCount));
  const breaks: Array<readonly [string, number]> = [];
  for (const [w, [cp, cn]] of wordFreq) {
    if (cp > 0 && cn > 0 && cp < prevFreqCutoff && cn < nextFreqCutoff) {
      breaks.push([w, cp + cn]);
    }
  }
  breaks.sort((a, b) => a[1] - b[1]);
  const breakSet = new Set(breaks.slice(0, targetNumBlocks).map(([w]) => w));
  const findBreaksIn = (words: readonly (readonly string[])[]): Map<string, number> => {
    const out = new Map<string, number>();
    for (let i = 0; i < words.length; i++) {
      const line = words[i]!;
      const found = line.find((w) => breakSet.has(w));
      if (found !== undefined && !out.has(found)) out.set(found, i);
    }
    return out;
  };
  const lineBreaksPrev = findBreaksIn(prevWords);
  const lineBreaksNext = findBreaksIn(nextWords);
  const candidates: Array<readonly [number, number]> = [];
  for (const [k, pIdx] of lineBreaksPrev) {
    const nIdx = lineBreaksNext.get(k);
    if (nIdx !== undefined) candidates.push([pIdx, nIdx]);
  }
  candidates.sort((a, b) => a[1] - b[1]);
  const lineBreaks: Array<readonly [number, number]> = [];
  let lastPrev = -1;
  let lastNext = -1;
  for (const [p, n] of candidates) {
    if (p > lastPrev && p - lastPrev > TARGET_BLOCK_SIZE / 2 && n - lastNext > TARGET_BLOCK_SIZE / 2) {
      lastPrev = p;
      lastNext = n;
      lineBreaks.push([p, n]);
    }
  }
  const result: Array<readonly [readonly (readonly string[])[], readonly (readonly string[])[]]> = [];
  let lastPI = 0;
  let lastNI = 0;
  for (const [pI, nI] of [...lineBreaks, [prevAr.length, nextAr.length] as const]) {
    result.push([prevWords.slice(lastPI, pI), nextWords.slice(lastNI, nI)] as const);
    lastPI = pI;
    lastNI = nI;
  }
  return result;
};

type SubDiffSplitItem = { readonly kind: "range"; readonly range: Range<WordOrNewline> } | { readonly kind: "break" };

const getNewLenSoFar = (lenSoFar: number, tokens: readonly WordOrNewline[]): number => {
  let len = lenSoFar;
  for (const t of tokens) {
    if (t.kind === "newline") len = 0;
    else len += t.value.length;
  }
  return len;
};

const makeNewlineSameRange = (): Range<WordOrNewline> => Range.same([[newlineToken(), newlineToken()] as const]);

/** Take token pairs from a Same range until we exceed max_len or hit a newline. */
const takeUntilMax = (
  lenSoFar: number,
  tokenpairs: ReadonlyArray<readonly [WordOrNewline, WordOrNewline]>,
  maxLen: number,
): readonly [number, Range<WordOrNewline>, ReadonlyArray<readonly [WordOrNewline, WordOrNewline]>, boolean] => {
  const accum: Array<readonly [WordOrNewline, WordOrNewline]> = [];
  let i = 0;
  let len = lenSoFar;
  while (i < tokenpairs.length) {
    const tp = tokenpairs[i]!;
    const [tok] = tp;
    if (tok.kind === "newline") {
      accum.push(tp);
      return [0, Range.same(accum), tokenpairs.slice(i + 1), true];
    }
    const wordlen = tok.value.length;
    if (wordlen + len > maxLen && len > 0) {
      return [0, Range.same(accum), tokenpairs.slice(i), false];
    }
    len = wordlen + len;
    accum.push(tp);
    i++;
  }
  return [len, Range.same(accum), [], false];
};

const splitLongLinesIntoRangeLists = (
  subDiff: readonly Range<WordOrNewline>[],
  maxLen: number,
): Range<WordOrNewline>[][] => {
  let rangeAccum: Range<WordOrNewline>[] = [];
  const rangeListAccum: Range<WordOrNewline>[][] = [];
  let lenSoFar = 0;
  for (const range of subDiff) {
    switch (range.kind) {
      case "same": {
        const tokenpairsArr = range.contents;
        let remaining: ReadonlyArray<readonly [WordOrNewline, WordOrNewline]> = tokenpairsArr;
        const newRanges: SubDiffSplitItem[] = [];
        while (remaining.length > 0) {
          const [newLen, newRange, newRemaining, hitNewline] = takeUntilMax(lenSoFar, remaining, maxLen);
          newRanges.push({ kind: "range", range: newRange });
          if (newRemaining.length > 0 && !hitNewline) {
            // The synthetic newline terminates the chunk being flushed — a
            // break first would leave it mid-line, which collapse rejects.
            newRanges.push({ kind: "range", range: makeNewlineSameRange() });
            newRanges.push({ kind: "break" });
          }
          lenSoFar = newLen;
          remaining = newRemaining;
        }
        for (const r of newRanges) {
          if (r.kind === "break") {
            rangeListAccum.push(rangeAccum);
            rangeAccum = [];
          } else {
            rangeAccum.push(r.range);
          }
        }
        break;
      }
      case "next":
      case "prev": {
        lenSoFar = getNewLenSoFar(lenSoFar, range.contents);
        rangeAccum.push(range);
        break;
      }
      case "replace": {
        lenSoFar = Math.max(getNewLenSoFar(lenSoFar, range.prev), getNewLenSoFar(lenSoFar, range.next));
        rangeAccum.push(range);
        break;
      }
      case "unified":
        throw new Error("splitLongLinesIntoRangeLists: unexpected Unified");
    }
  }
  if (rangeAccum.length > 0) rangeListAccum.push(rangeAccum);
  return rangeListAccum;
};

const allSame = (ranges: readonly Range<WordOrNewline>[], keepWs: boolean): boolean => {
  for (const r of ranges) {
    if (r.kind === "same") continue;
    if (r.kind === "prev" || r.kind === "next") {
      if (keepWs) return false;
      for (const t of r.contents) {
        if (t.kind !== "newline") return false;
      }
      continue;
    }
    return false;
  }
  return true;
};

type MapNonReplaceResult<A> = ReadonlyArray<Range<A>>;

type CollapseRangeArgs = {
  readonly prevAllSame: boolean;
  readonly nextAllSame: boolean;
  readonly subPrev: readonly Range<WordOrNewline>[];
  readonly subNext: readonly Range<WordOrNewline>[];
  readonly moveKind: MoveId | undefined;
};

/** Internal driver shared by [refine] and [refineStructured]. */
const refineInternal = <A>(args: {
  readonly markNewlineChanges?: boolean;
  readonly mapNonReplace: (keepWs: boolean, range: Range<string>) => MapNonReplaceResult<A>;
  readonly lineIsWs: (line: A) => boolean;
  readonly collapseRange: (a: CollapseRangeArgs) => ReadonlyArray<readonly [readonly A[], readonly A[]]>;
  readonly produceUnifiedLines: boolean;
  readonly keepWs: boolean;
  readonly splitLongLines: boolean;
  readonly interleave: boolean;
  readonly wordBigEnough: number;
  readonly hunks: readonly Hunk<string>[];
}): Hunk<A>[] => {
  const {
    markNewlineChanges = false,
    mapNonReplace,
    lineIsWs,
    collapseRange,
    produceUnifiedLines,
    keepWs,
    splitLongLines,
    interleave,
    wordBigEnough,
    hunks,
  } = args;

  const handleReplace = (
    prevAr: readonly string[],
    nextAr: readonly string[],
    moveKind: MoveId | undefined,
  ): Range<A>[] => {
    const prevPieces = explodeInternal(
      prevAr.map((s) => (keepWs ? split(s, true) : whitespaceIgnorantSplit(s))),
      keepWs,
    );
    const nextPieces = explodeInternal(
      nextAr.map((s) => (keepWs ? split(s, true) : whitespaceIgnorantSplit(s))),
      keepWs,
    );
    const subDiffHunks = diffPieces({ prevPieces, nextPieces, keepWs, wordBigEnough });
    const subDiffRanges: Range<WordOrNewline>[] = [];
    for (const h of subDiffHunks) {
      for (const r of h.ranges) subDiffRanges.push(r);
    }
    const subDiffPiecesList: Range<WordOrNewline>[][] = splitLongLines
      ? splitLongLinesIntoRangeLists(subDiffRanges, DEFAULT_REFINE_LINE_LENGTH)
      : [subDiffRanges];
    const subDiffPieces = interleave ? subDiffPiecesList.flatMap(splitForReadability) : subDiffPiecesList;

    const result: Range<A>[] = [];
    for (const subDiff of subDiffPieces) {
      const subPrev = Range.prevOnly(subDiff);
      const subNext = Range.nextOnly(subDiff);
      const prevAllSame = allSame(subPrev, keepWs);
      const nextAllSame = allSame(subNext, keepWs);
      const produceUnifiedNow =
        produceUnifiedLines &&
        ((!rangesAreJustWhitespace(subPrev) && nextAllSame) || (!rangesAreJustWhitespace(subNext) && prevAllSame));
      const pairs = collapseRange({
        prevAllSame,
        nextAllSame,
        subPrev,
        subNext,
        moveKind,
      });
      for (const [prevA, nextA] of pairs) {
        let range: Range<A>;
        if (prevAllSame && nextAllSame && moveKind === undefined) {
          if (prevA.length === nextA.length) {
            const pairsAB: Array<readonly [A, A]> = [];
            for (let i = 0; i < prevA.length; i++) {
              pairsAB.push([prevA[i]!, nextA[i]!] as const);
            }
            range = Range.same(pairsAB);
          } else if (markNewlineChanges) {
            range = Range.replace(prevA, nextA, moveKind);
          } else {
            const pairsAB: Array<readonly [A, A]> = nextA.map((x) => [x, x] as const);
            range = Range.same(pairsAB);
          }
        } else if (prevA.length === 1 && lineIsWs(prevA[0]!)) {
          range = Range.replace([], nextA, moveKind);
        } else if (nextA.length === 1 && lineIsWs(nextA[0]!)) {
          range = Range.replace(prevA, [], moveKind);
        } else if (produceUnifiedNow && prevAllSame && !nextAllSame) {
          range = Range.unified(nextA, moveKind);
        } else if (produceUnifiedNow && !prevAllSame && nextAllSame) {
          range = Range.unified(prevA, moveKind);
        } else if (!produceUnifiedNow || (!prevAllSame && !nextAllSame)) {
          range = Range.replace(prevA, nextA, moveKind);
        } else {
          throw new Error("refineInternal: unreachable case");
        }
        result.push(range);
      }
    }
    return result;
  };

  const refineRange = (range: Range<string>): Range<A>[] => {
    if (range.kind === "replace") {
      const moveKind = range.moveId;
      const arrays = wordsBreakHeuristic(range.prev, range.next, keepWs);
      const out: Range<A>[] = [];
      for (const [pa, na] of arrays) {
        const pl = pa.map((l) => l.join(""));
        const nl = na.map((l) => l.join(""));
        for (const r of handleReplace(pl, nl, moveKind)) out.push(r);
      }
      return out;
    }
    return [...mapNonReplace(keepWs, range)];
  };

  const filtered: Hunk<A>[] = [];
  for (const hunk of hunks) {
    const newRanges: Range<A>[] = [];
    for (const r of hunk.ranges) {
      for (const x of refineRange(r)) newRanges.push(x);
    }
    const newHunk: Hunk<A> = { ...hunk, ranges: newRanges };
    if (!Range.allSame(newRanges)) filtered.push(newHunk);
  }
  return filtered;
};

// ===== refineStructured =====

export type RefineStructuredArgs = {
  readonly markNewlineChanges?: boolean;
  readonly produceUnifiedLines: boolean;
  readonly keepWs: boolean;
  readonly splitLongLines: boolean;
  readonly interleave: boolean;
  readonly wordBigEnough: number;
  readonly hunks: readonly Hunk<string>[];
};

export const refineStructured = (args: RefineStructuredArgs): StructuredHunks => {
  const markNewlineChanges = args.markNewlineChanges ?? false;
  type A = readonly StructuredLine[];
  return refineInternal<A>({
    ...(args.markNewlineChanges !== undefined ? { markNewlineChanges: args.markNewlineChanges } : {}),
    produceUnifiedLines: args.produceUnifiedLines,
    keepWs: args.keepWs,
    splitLongLines: args.splitLongLines,
    interleave: args.interleave,
    wordBigEnough: args.wordBigEnough,
    hunks: args.hunks,
    lineIsWs: () => false,
    mapNonReplace: (keepWs, range): MapNonReplaceResult<A> => {
      const wsCheck = (arr: readonly string[]): boolean => {
        if (markNewlineChanges) return false;
        if (keepWs) return false;
        return arr.every(isWs);
      };
      switch (range.kind) {
        case "next": {
          if (range.moveKind === undefined && wsCheck(range.contents)) {
            const pairs: Array<readonly [A, A]> = range.contents.map((l): readonly [A, A] => {
              const line: A = [tagPair("Same", l)];
              return [line, line] as const;
            });
            return [Range.same(pairs)];
          }
          const wrapped: A[] = range.contents.map((l): A => [tagPair("Same", l)]);
          return [Range.next(wrapped, range.moveKind)];
        }
        case "prev": {
          if (range.moveKind === undefined && wsCheck(range.contents)) return [];
          const wrapped: A[] = range.contents.map((l): A => [tagPair("Same", l)]);
          return [Range.prev(wrapped, range.moveKind)];
        }
        case "same": {
          const wrapped = range.contents.map(
            ([p, n]): readonly [A, A] => [[tagPair("Same", p)], [tagPair("Same", n)]] as const,
          );
          return [Range.same(wrapped)];
        }
        case "unified": {
          const wrapped: A[] = range.contents.map((l): A => [tagPair("Same", l)]);
          return [Range.unified(wrapped, range.moveId)];
        }
        case "replace":
          throw new Error("refineStructured.mapNonReplace: unexpected Replace");
      }
    },
    collapseRange: ({ subPrev, subNext }) => {
      const prev = collapseStructured(subPrev, "PrevOnly");
      const next = collapseStructured(subNext, "NextOnly");
      return [[prev, next] as const];
    },
  });
};

// ===== refine (string output) =====

export type RefineArgs = {
  readonly rules: Format.Rules;
  readonly produceUnifiedLines: boolean;
  readonly output: Output;
  readonly outputImpl: OutputS;
  readonly keepWs: boolean;
  readonly splitLongLines: boolean;
  readonly interleave: boolean;
  readonly wordBigEnough: number;
  readonly hunks: Hunks;
};

export const refine = (args: RefineArgs): Hunks => {
  const { rules, produceUnifiedLines, output, outputImpl, keepWs, splitLongLines, interleave, wordBigEnough, hunks } =
    args;
  if (output === "Ascii" && produceUnifiedLines) {
    throw new Error("produceUnifiedLines is not supported in Ascii mode");
  }
  const rulePrev = rules.wordPrev;
  const ruleNext = rules.wordNext;
  const collapseLocal = (
    ranges: readonly Range<WordOrNewline>[],
    ruleSame: Format.Rule,
    kind: CollapseKind,
  ): readonly string[] =>
    collapseStrings({
      ranges,
      ruleSame,
      rulePrev,
      ruleNext,
      kind,
      outputImpl,
    });

  return refineInternal<string>({
    produceUnifiedLines,
    keepWs,
    splitLongLines,
    interleave,
    wordBigEnough,
    hunks,
    lineIsWs: (line) => line === "",
    mapNonReplace: (kw, range) => {
      switch (range.kind) {
        case "next":
          if (!kw && range.contents.every(isWs)) {
            const pairs: Array<readonly [string, string]> = range.contents.map((x) => [x, x] as const);
            return [Range.same(pairs)];
          }
          return [range];
        case "prev":
          if (!kw && range.contents.every(isWs)) return [];
          return [range];
        case "same":
        case "unified":
          return [range];
        case "replace":
          throw new Error("refine.mapNonReplace: unexpected Replace");
      }
    },
    collapseRange: ({ prevAllSame, nextAllSame, subPrev, subNext, moveKind }) => {
      if (prevAllSame && nextAllSame) {
        const ruleSame = moveKind === undefined ? rules.wordSameUnified : rules.wordSameUnifiedInMove;
        if (moveKind === undefined) {
          const nextAr = collapseLocal(subNext, ruleSame, "NextOnly");
          return [[nextAr, nextAr] as const];
        }
        const prevAr = collapseLocal(subPrev, ruleSame, "PrevOnly");
        const nextAr = collapseLocal(subNext, ruleSame, "NextOnly");
        return [[prevAr, nextAr] as const];
      }
      if (!prevAllSame && nextAllSame) {
        const ruleSamePrev = produceUnifiedLines
          ? moveKind === undefined
            ? rules.wordSameUnified
            : rules.wordSameUnifiedInMove
          : rules.wordSamePrev;
        const prevAr = collapseLocal(subPrev, ruleSamePrev, "PrevOnly");
        const nextAr = collapseLocal(subNext, rules.wordSameNext, "NextOnly");
        return [[prevAr, nextAr] as const];
      }
      if (prevAllSame && !nextAllSame) {
        const ruleSameNext = produceUnifiedLines
          ? moveKind === undefined
            ? rules.wordSameUnified
            : rules.wordSameUnifiedInMove
          : rules.wordSameNext;
        const nextAr = collapseLocal(subNext, ruleSameNext, "NextOnly");
        const prevAr = collapseLocal(subPrev, rules.wordSamePrev, "PrevOnly");
        return [[prevAr, nextAr] as const];
      }
      const prevAr = collapseLocal(subPrev, rules.wordSamePrev, "PrevOnly");
      const nextAr = collapseLocal(subNext, rules.wordSameNext, "NextOnly");
      return [[prevAr, nextAr] as const];
    },
  });
};

/** Wrap an unrefined hunk list into the same structured shape as [refineStructured]. */
export const unrefinedStructured = (hunks: readonly Hunk<string>[]): StructuredHunks =>
  hunks.map((hunk) => ({
    ...hunk,
    ranges: hunk.ranges.map((range): Range<readonly StructuredLine[]> => {
      switch (range.kind) {
        case "same": {
          const pairs = range.contents.map(
            ([p, n]) =>
              [
                [tagPair("Same", p)] as readonly StructuredLine[],
                [tagPair("Same", n)] as readonly StructuredLine[],
              ] as const,
          );
          return Range.same(pairs);
        }
        case "prev": {
          const wrapped = range.contents.map((l) => [tagPair("Prev", l)] as readonly StructuredLine[]);
          return Range.prev(wrapped, range.moveKind);
        }
        case "next": {
          const wrapped = range.contents.map((l) => [tagPair("Next", l)] as readonly StructuredLine[]);
          return Range.next(wrapped, range.moveKind);
        }
        case "replace": {
          const p = range.prev.map((l) => [tagPair("Prev", l)] as readonly StructuredLine[]);
          const n = range.next.map((l) => [tagPair("Next", l)] as readonly StructuredLine[]);
          return Range.replace(p, n, range.moveId);
        }
        case "unified": {
          const wrapped = range.contents.map((l) => [tagPair("Same", l)] as readonly StructuredLine[]);
          return Range.unified(wrapped, range.moveId);
        }
      }
    }),
  }));

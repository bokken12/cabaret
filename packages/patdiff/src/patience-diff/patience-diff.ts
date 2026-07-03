/** Port of Bram Cohen's patience diff algorithm. */

import type { Hunk } from "./hunk.js";
import type { MatchingBlock } from "./matching-block.js";
import * as PlainDiff from "./plain-diff.js";
import { Range } from "./range.js";

export { Hunk } from "./hunk.js";
export { Hunks } from "./hunks.js";
export type { MatchingBlock } from "./matching-block.js";
export { MoveId } from "./move-id.js";
export { MoveKind } from "./move-kind.js";
export { Range } from "./range.js";

// Helper: array slice that returns [] when j <= i (matches OCaml's <|> operator).
function slice<T>(arr: ReadonlyArray<T>, i: number, j: number): T[] {
  if (j <= i) return [];
  return arr.slice(i, j) as T[];
}

// Does the nitty gritty of turning indexes into line numbers and reversing the ranges,
// returning a nice new hunk.
function createHunk<T>(
  prevStart: number,
  prevStop: number,
  nextStart: number,
  nextStop: number,
  rangesRev: Range<T>[],
): Hunk<T> {
  return {
    prevStart: prevStart + 1,
    prevSize: prevStop - prevStart,
    nextStart: nextStart + 1,
    nextSize: nextStop - nextStart,
    ranges: rangesRev.slice().reverse(),
  };
}

// ===== Ordered_sequence =====
// A list of (int, int) pairs with second coordinates in increasing order. Sort by y, then
// by x (lexicographic on (y, x)).
type OrderedElt = readonly [number, number];

function compareOrderedElt(a: OrderedElt, b: OrderedElt): number {
  const dy = a[1] - b[1];
  if (dy !== 0) return dy;
  return a[0] - b[0];
}

function orderedSequenceCreate(arr: Array<[number, number]>): OrderedElt[] {
  const copy: OrderedElt[] = arr.slice();
  copy.sort(compareOrderedElt);
  return copy;
}

// ===== Patience (LIS via patience sorting) =====
// Each card has a value and an optional backpointer to a card in the previous pile, used
// to reconstruct the LIS.
type Card = {
  value: OrderedElt;
  back: Card | undefined;
};

function backToList(card: Card): OrderedElt[] {
  const out: OrderedElt[] = [];
  let c: Card | undefined = card;
  while (c !== undefined) {
    out.push(c.value);
    c = c.back;
  }
  out.reverse();
  return out;
}

// Patience sorting: place each card on the leftmost pile whose top is strictly greater
// than it; if none, start a new pile to the right. The backpointer of each card points
// to the current top of the pile to its left.
function longestIncreasingSubsequence(ar: OrderedElt[]): OrderedElt[] {
  if (ar.length === 0) return [];
  // piles[i] = top card of pile i. Top of pile is just the latest pushed card.
  // We only need pile tops for binary search; for backpointers we also keep the previous
  // pile's top at the moment of insertion via the card's [back] pointer.
  const pileTops: Card[] = [];
  for (const x of ar) {
    // Binary search for first pile whose top's first coord > x[0]. (Original code uses
    // `First_strictly_greater_than` and compares on the first coord.)
    let lo = 0;
    let hi = pileTops.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pileTops[mid]!.value[0] > x[0]) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    const i = lo === pileTops.length ? -1 : lo;
    const back =
      i === -1
        ? pileTops.length > 0
          ? pileTops[pileTops.length - 1]
          : undefined
        : i === 0
          ? undefined
          : pileTops[i - 1];
    const card: Card = { value: x, back };
    if (i === -1) {
      pileTops.push(card);
    } else {
      pileTops[i] = card;
    }
  }
  return backToList(pileTops[pileTops.length - 1]!);
}

// Tuning constants from the original code.
const switchToPlainDiffNumerator = 1;
const switchToPlainDiffDenominator = 10;

function shouldDiscardIfOtherSideEqual(bigEnough: number): number {
  return Math.trunc(100 / bigEnough);
}

// ===== Score callback type =====
export type ScoreSide = "left" | "right";
export type Score<U> = (side: ScoreSide, a: U, b: U) => number;

// ===== Public per-elt API =====

export type Segment<T> = { kind: "same"; contents: T[] } | { kind: "different"; contents: T[][] };

export type MergedArray<T> = Segment<T>[];

export type GetMatchingBlocksArgs<A, Elt> = {
  transform: (a: A) => Elt;
  bigEnough?: number;
  maxSlide?: number;
  score?: Score<A>;
  prev: ReadonlyArray<A>;
  next: ReadonlyArray<A>;
};

export type GetHunksArgs<A, Elt> = GetMatchingBlocksArgs<A, Elt> & {
  context: number;
};

export type EltOps<Elt> = {
  compare: (a: Elt, b: Elt) => number;
  hash: (x: Elt) => string | number;
};

// ===== unique_lcs =====
type LineMetadata =
  | { kind: "uniqueInA"; indexInA: number }
  | { kind: "uniqueInAB"; indexInA: number; indexInB: number }
  | { kind: "notUnique"; occurrencesInA: number };

type UniqueLcsResult = { kind: "notEnoughUniqueTokens" } | { kind: "computedLcs"; lcs: OrderedElt[] };

function uniqueLcs<Elt>(
  ops: EltOps<Elt>,
  alpha: ReadonlyArray<Elt>,
  alo: number,
  ahi: number,
  bravo: ReadonlyArray<Elt>,
  blo: number,
  bhi: number,
): UniqueLcsResult {
  const unique = new Map<string | number, LineMetadata>();
  for (let xPosInA = alo; xPosInA < ahi; xPosInA++) {
    const x = alpha[xPosInA]!;
    const key = ops.hash(x);
    const found = unique.get(key);
    if (found === undefined) {
      unique.set(key, { kind: "uniqueInA", indexInA: xPosInA });
    } else if (found.kind === "uniqueInA") {
      unique.set(key, { kind: "notUnique", occurrencesInA: 2 });
    } else if (found.kind === "notUnique") {
      unique.set(key, {
        kind: "notUnique",
        occurrencesInA: found.occurrencesInA + 1,
      });
    }
    // uniqueInAB case doesn't occur in first pass.
  }
  let numPairs = 0;
  let intersectionSize = 0;
  for (let xPosInB = blo; xPosInB < bhi; xPosInB++) {
    const x = bravo[xPosInB]!;
    const key = ops.hash(x);
    const pos = unique.get(key);
    if (pos === undefined) continue;
    if (pos.kind === "notUnique") {
      if (pos.occurrencesInA > 0) {
        unique.set(key, {
          kind: "notUnique",
          occurrencesInA: pos.occurrencesInA - 1,
        });
        intersectionSize += 1;
      }
    } else if (pos.kind === "uniqueInA") {
      numPairs += 1;
      intersectionSize += 1;
      unique.set(key, {
        kind: "uniqueInAB",
        indexInA: pos.indexInA,
        indexInB: xPosInB,
      });
    } else {
      // uniqueInAB — a duplicate hit in b. Demote to notUnique with 0.
      numPairs -= 1;
      unique.set(key, { kind: "notUnique", occurrencesInA: 0 });
    }
  }
  if (numPairs * switchToPlainDiffDenominator < intersectionSize * switchToPlainDiffNumerator) {
    return { kind: "notEnoughUniqueTokens" };
  }
  const arr: Array<[number, number]> = new Array(numPairs);
  let i = 0;
  for (const v of unique.values()) {
    if (v.kind === "uniqueInAB") {
      arr[i] = [v.indexInA, v.indexInB];
      i += 1;
    }
  }
  const ab = orderedSequenceCreate(arr);
  return { kind: "computedLcs", lcs: longestIncreasingSubsequence(ab) };
}

// ===== matches =====
function matches<Elt>(ops: EltOps<Elt>, alpha: ReadonlyArray<Elt>, bravo: ReadonlyArray<Elt>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let outLen = 0;
  const addMatch = (m: [number, number]): void => {
    outLen += 1;
    out.push(m);
  };

  const recurse = (alo: number, blo: number, ahi: number, bhi: number): void => {
    const oldLength = outLen;
    if (alo >= ahi || blo >= bhi) return;
    if (ops.compare(alpha[alo]!, bravo[blo]!) === 0) {
      let a = alo;
      let b = blo;
      while (a < ahi && b < bhi && ops.compare(alpha[a]!, bravo[b]!) === 0) {
        addMatch([a, b]);
        a += 1;
        b += 1;
      }
      recurse(a, b, ahi, bhi);
      return;
    }
    if (ops.compare(alpha[ahi - 1]!, bravo[bhi - 1]!) === 0) {
      let nahi = ahi - 1;
      let nbhi = bhi - 1;
      while (nahi > alo && nbhi > blo && ops.compare(alpha[nahi - 1]!, bravo[nbhi - 1]!) === 0) {
        nahi -= 1;
        nbhi -= 1;
      }
      recurse(alo, blo, nahi, nbhi);
      for (let i = 0; i < ahi - nahi; i++) {
        addMatch([nahi + i, nbhi + i]);
      }
      return;
    }
    let lastAPos = alo - 1;
    let lastBPos = blo - 1;
    const plainDiff = (): void => {
      PlainDiff.iterMatches({
        a: alpha.slice(alo, ahi),
        b: bravo.slice(blo, bhi),
        hash: ops.hash,
        f: ([i1, i2]) => addMatch([alo + i1, blo + i2]),
      });
    };
    const result = uniqueLcs(ops, alpha, alo, ahi, bravo, blo, bhi);
    if (result.kind === "notEnoughUniqueTokens") {
      plainDiff();
      return;
    }
    for (const [apos, bpos] of result.lcs) {
      if (lastAPos + 1 !== apos || lastBPos + 1 !== bpos) {
        recurse(lastAPos + 1, lastBPos + 1, apos, bpos);
      }
      lastAPos = apos;
      lastBPos = bpos;
      addMatch([apos, bpos]);
    }
    if (outLen > oldLength) {
      recurse(lastAPos + 1, lastBPos + 1, ahi, bhi);
    } else {
      plainDiff();
    }
  };

  recurse(0, 0, alpha.length, bravo.length);
  return out;
}

function collapseSequences(matchList: Array<[number, number]>): MatchingBlock[] {
  const collapsed: MatchingBlock[] = [];
  let startA: number | undefined;
  let startB: number | undefined;
  let length = 0;
  for (const [iA, iB] of matchList) {
    if (startA !== undefined && startB !== undefined && iA === startA + length && iB === startB + length) {
      length += 1;
    } else {
      if (startA !== undefined && startB !== undefined) {
        collapsed.push({ prevStart: startA, nextStart: startB, length });
      }
      startA = iA;
      startB = iB;
      length = 1;
    }
  }
  if (startA !== undefined && startB !== undefined && length !== 0) {
    collapsed.push({ prevStart: startA, nextStart: startB, length });
  }
  return collapsed;
}

function shouldDiscardMatch(bigEnough: number, leftChange: number, rightChange: number, blockLen: number): boolean {
  return (
    blockLen < bigEnough &&
    ((leftChange > blockLen && rightChange > blockLen) ||
      (leftChange >= blockLen + shouldDiscardIfOtherSideEqual(bigEnough) && rightChange === blockLen) ||
      (rightChange >= blockLen + shouldDiscardIfOtherSideEqual(bigEnough) && leftChange === blockLen))
  );
}

function changeBetween(left: MatchingBlock, right: MatchingBlock): number {
  return Math.max(right.prevStart - left.prevStart, right.nextStart - left.nextStart) - left.length;
}

// Basic semantic cleanup: walks blocks left-to-right keeping a "pending" candidate; if
// pending is sandwiched between large enough changes, drop it.
function basicSemanticCleanup(bigEnough: number, blocks: MatchingBlock[]): MatchingBlock[] {
  if (bigEnough <= 1) return blocks;
  if (blocks.length === 0) return [];
  let pending = blocks[0]!;
  const ans: MatchingBlock[] = [];
  for (let idx = 1; idx < blocks.length; idx++) {
    const current = blocks[idx]!;
    // Loop: while the top of [ans] makes [pending] look discardable, pop.
    while (ans.length > 0) {
      const top = ans[ans.length - 1]!;
      if (shouldDiscardMatch(bigEnough, changeBetween(top, pending), changeBetween(pending, current), pending.length)) {
        ans.pop();
        pending = top;
      } else {
        break;
      }
    }
    ans.push(pending);
    pending = current;
  }
  ans.push(pending);
  return ans;
}

// Advanced semantic cleanup: tries combining consecutive pairs and applies basic on
// result.
function advancedSemanticCleanup(bigEnough: number, blocks: MatchingBlock[]): MatchingBlock[] {
  if (bigEnough <= 1) return blocks;
  if (blocks.length === 0) return [];
  if (blocks.length === 1) return blocks.slice();
  let pendingA = blocks[0]!;
  let pendingB = blocks[1]!;
  const ans: MatchingBlock[] = [];
  for (let idx = 2; idx < blocks.length; idx++) {
    const current = blocks[idx]!;
    while (ans.length > 0) {
      const top = ans[ans.length - 1]!;
      const blockLen =
        pendingB.length + Math.min(pendingB.prevStart - pendingA.prevStart, pendingB.nextStart - pendingA.nextStart);
      if (shouldDiscardMatch(bigEnough, changeBetween(top, pendingA), changeBetween(pendingB, current), blockLen)) {
        ans.pop();
        pendingB = pendingA;
        pendingA = top;
      } else {
        break;
      }
    }
    ans.push(pendingA);
    pendingA = pendingB;
    pendingB = current;
  }
  ans.push(pendingA);
  ans.push(pendingB);
  return basicSemanticCleanup(bigEnough, ans);
}

function semanticCleanup(bigEnough: number, blocks: MatchingBlock[]): MatchingBlock[] {
  return advancedSemanticCleanup(bigEnough, basicSemanticCleanup(bigEnough, blocks));
}

// When we have a choice, prefer one block of equality to two. E.g. instead of
// A <insert>B A</insert> C D E F, we prefer <insert>A B</insert> A C D E F.
function combineEqualities<Elt>(
  ops: EltOps<Elt>,
  prev: ReadonlyArray<Elt>,
  next: ReadonlyArray<Elt>,
  ms: MatchingBlock[],
): MatchingBlock[] {
  if (ms.length === 0) return [];
  let pending = ms[0]!;
  const ans: MatchingBlock[] = [];
  for (let idx = 1; idx < ms.length; idx++) {
    const block = ms[idx]!;
    // Try to shrink [pending] and grow [newBlock] leftward. Use [trialPending] /
    // [trialNewBlock] for the in-progress shrink so we can fall back to the original
    // [pending] / [block] if the shrink doesn't reduce pending to <= 1 element.
    let trialPending = pending;
    let trialNewBlock = block;
    while (trialPending.length !== 0) {
      const advanceInPrev =
        ops.compare(prev[trialPending.prevStart + trialPending.length - 1]!, prev[trialNewBlock.prevStart - 1]!) === 0;
      const advanceInNext =
        ops.compare(next[trialPending.nextStart + trialPending.length - 1]!, next[trialNewBlock.nextStart - 1]!) === 0;
      if (advanceInPrev && advanceInNext) {
        trialPending = {
          prevStart: trialPending.prevStart,
          nextStart: trialPending.nextStart,
          length: trialPending.length - 1,
        };
        trialNewBlock = {
          prevStart: trialNewBlock.prevStart - 1,
          nextStart: trialNewBlock.nextStart - 1,
          length: trialNewBlock.length + 1,
        };
      } else {
        break;
      }
    }
    if (trialPending.length === 0 || trialPending.length === 1) {
      if (trialPending.length !== 0) ans.push(trialPending);
      pending = trialNewBlock;
    } else {
      ans.push(pending);
      pending = block;
    }
  }
  ans.push(pending);
  return ans;
}

// Try to slide a diff (immediately preceded/followed by the same lines as it ends/starts
// with) to a better position. We pick the position that maximizes the score.
function alignDiffs<A, Elt>(
  ops: EltOps<Elt>,
  prevElts: ReadonlyArray<Elt>,
  prevScorable: ReadonlyArray<A>,
  nextElts: ReadonlyArray<Elt>,
  nextScorable: ReadonlyArray<A>,
  maxSlide: number,
  scoreFn: Score<A>,
  blocks: MatchingBlock[],
): MatchingBlock[] {
  if (maxSlide === 0) return blocks;
  if (blocks.length === 0) return [];

  const scoreEltAndPrev = (arr: ReadonlyArray<A>, side: ScoreSide, i: number): number => {
    const i0 = i - 1;
    const i1 = i;
    if (i0 < 0 || i1 >= arr.length) return 100;
    return scoreFn(side, arr[i0]!, arr[i1]!);
  };

  const scorePrime = (arr: ReadonlyArray<A>, left: number, right: number): number =>
    scoreEltAndPrev(arr, "right", right) + scoreEltAndPrev(arr, "left", left + 1);

  const score = (prevLeft: number, prevRight: number, nextLeft: number, nextRight: number): number => {
    const prevTouching = prevLeft + 1 === prevRight;
    const nextTouching = nextLeft + 1 === nextRight;
    if (prevTouching && nextTouching) return 0;
    if (prevTouching) {
      return scorePrime(nextScorable, nextLeft, nextRight);
    }
    if (nextTouching) {
      return scorePrime(prevScorable, prevLeft, prevRight);
    }
    return Math.min(scorePrime(prevScorable, prevLeft, prevRight), scorePrime(nextScorable, nextLeft, nextRight));
  };

  const acc: MatchingBlock[] = [];
  let leftBlock = blocks[0]!;
  const rightBlocks = blocks.slice(1);

  while (rightBlocks.length > 0) {
    if (leftBlock.length === 0) {
      leftBlock = rightBlocks.shift()!;
      continue;
    }
    const rightBlock = rightBlocks[0]!;

    let bestScore = score(
      leftBlock.prevStart + leftBlock.length - 1,
      rightBlock.prevStart,
      leftBlock.nextStart + leftBlock.length - 1,
      rightBlock.nextStart,
    );
    let offsetOfBestScore = 0;

    // Try to slide left.
    for (let i = 1; ; i++) {
      const offsetIntoLeft = leftBlock.length - i;
      if (offsetIntoLeft < 0) break;
      if (i > maxSlide) break;
      const prevLeft = leftBlock.prevStart + offsetIntoLeft - 1;
      const prevRight = rightBlock.prevStart - i;
      const nextLeft = leftBlock.nextStart + offsetIntoLeft - 1;
      const nextRight = rightBlock.nextStart - i;
      if (ops.compare(nextElts[nextLeft + 1]!, nextElts[nextRight]!) !== 0) break;
      if (ops.compare(prevElts[prevLeft + 1]!, prevElts[prevRight]!) !== 0) break;
      const s = score(prevLeft, prevRight, nextLeft, nextRight);
      if (s > bestScore) {
        bestScore = s;
        offsetOfBestScore = -i;
      }
    }
    // Try to slide right.
    for (let i = 1; ; i++) {
      const offsetIntoLeft = leftBlock.length + i - 1;
      if (i > rightBlock.length) break;
      if (i > maxSlide) break;
      const prevLeft = leftBlock.prevStart + offsetIntoLeft;
      const prevRight = rightBlock.prevStart + i;
      const nextLeft = leftBlock.nextStart + offsetIntoLeft;
      const nextRight = rightBlock.nextStart + i;
      if (ops.compare(nextElts[nextLeft]!, nextElts[nextRight - 1]!) !== 0) break;
      if (ops.compare(prevElts[prevLeft]!, prevElts[prevRight - 1]!) !== 0) break;
      const s = score(prevLeft, prevRight, nextLeft, nextRight);
      if (s > bestScore) {
        bestScore = s;
        offsetOfBestScore = i;
      }
    }

    if (offsetOfBestScore === 0) {
      acc.push(leftBlock);
      leftBlock = rightBlocks.shift()!;
    } else {
      const slide = offsetOfBestScore;
      const newLeft: MatchingBlock = {
        prevStart: leftBlock.prevStart,
        nextStart: leftBlock.nextStart,
        length: leftBlock.length + slide,
      };
      const newRight: MatchingBlock = {
        prevStart: rightBlock.prevStart + slide,
        nextStart: rightBlock.nextStart + slide,
        length: rightBlock.length - slide,
      };
      if (newLeft.length > 0) acc.push(newLeft);
      leftBlock = newRight;
      rightBlocks.shift();
    }
  }
  acc.push(leftBlock);
  return acc;
}

// ===== get_matching_blocks =====
function getMatchingBlocksFromOps<A, Elt>(ops: EltOps<Elt>, args: GetMatchingBlocksArgs<A, Elt>): MatchingBlock[] {
  const bigEnough = args.bigEnough ?? 1;
  const maxSlide = args.maxSlide ?? 0;
  const score: Score<A> = args.score ?? (() => 100);
  const prevScorable = args.prev;
  const nextScorable = args.next;
  const prev = prevScorable.map(args.transform);
  const next = nextScorable.map(args.transform);
  const raw = matches(ops, prev, next);
  let collapsed = collapseSequences(raw);
  collapsed = combineEqualities(ops, prev, next, collapsed);
  const lastMatch: MatchingBlock = {
    prevStart: prev.length,
    nextStart: next.length,
    length: 0,
  };
  collapsed.push(lastMatch);
  let cleaned = semanticCleanup(bigEnough, collapsed);
  cleaned = alignDiffs(ops, prev, prevScorable, next, nextScorable, maxSlide, score, cleaned);
  return cleaned;
}

function getRangesRev<A, Elt>(ops: EltOps<Elt>, args: GetMatchingBlocksArgs<A, Elt>): Range<A>[] {
  const matchingBlocks = getMatchingBlocksFromOps(ops, args);
  const prev = args.prev;
  const next = args.next;
  const result: Range<A>[] = [];
  let i = 0;
  let j = 0;
  for (const block of matchingBlocks) {
    const { prevStart: pi, nextStart: ni, length: size } = block;
    if (pi < i || ni < j) continue;
    let rangeOpt: Range<A> | undefined;
    if (i < pi && j < ni) {
      rangeOpt = Range.replace(slice(prev, i, pi), slice(next, j, ni));
    } else if (i < pi) {
      rangeOpt = Range.prev(slice(prev, i, pi));
    } else if (j < ni) {
      rangeOpt = Range.next(slice(next, j, ni));
    }
    if (rangeOpt !== undefined) result.push(rangeOpt);
    const prevStop = pi + size;
    const nextStop = ni + size;
    if (size !== 0) {
      const pr = slice(prev, pi, prevStop);
      const nr = slice(next, ni, nextStop);
      const pairs: Array<readonly [A, A]> = [];
      for (let k = 0; k < pr.length; k++) {
        pairs.push([pr[k]!, nr[k]!] as const);
      }
      result.push(Range.same(pairs));
    }
    i = prevStop;
    j = nextStop;
  }
  return result;
}

function getHunksFromOps<A, Elt>(ops: EltOps<Elt>, args: GetHunksArgs<A, Elt>): Hunk<A>[] {
  const context = args.context;
  const ranges = getRangesRev(ops, args);
  const a = args.prev;
  const b = args.next;
  if (context < 0) {
    const singleton = createHunk(0, a.length, 0, b.length, ranges.slice().reverse());
    return [singleton];
  }

  // Initial trim of leading Same range, if any.
  let alo = 0;
  let ahi = 0;
  let blo = 0;
  let bhi = 0;
  let remaining: Range<A>[] = ranges;
  if (remaining.length > 0 && remaining[0]!.kind === "same") {
    const first = remaining[0]!;
    const arr = first.contents;
    const stop = arr.length;
    const start = Math.max(0, stop - context);
    const trimmed = Range.same(arr.slice(start, stop));
    remaining = [trimmed, ...remaining.slice(1)];
    alo = start;
    ahi = start;
    blo = start;
    bhi = start;
  }

  const accHunks: Hunk<A>[] = [];
  let currRangesRev: Range<A>[] = [];
  // Use index-based traversal of `remaining` so we can prepend without copying often.
  let idx = 0;
  while (idx < remaining.length) {
    const range = remaining[idx]!;
    const isLast = idx === remaining.length - 1;
    if (range.kind === "same") {
      if (isLast) {
        const arr = range.contents;
        const stop = Math.min(arr.length, context);
        const newRange = Range.same(arr.slice(0, stop));
        currRangesRev = [newRange, ...currRangesRev];
        ahi = ahi + stop;
        bhi = bhi + stop;
        accHunks.push(createHunk(alo, ahi, blo, bhi, currRangesRev));
        idx += 1;
        return accHunks;
      }
      const arr = range.contents;
      const size = arr.length;
      if (size > context * 2) {
        const newRange = Range.same(arr.slice(0, context));
        currRangesRev = [newRange, ...currRangesRev];
        ahi = ahi + context;
        bhi = bhi + context;
        accHunks.push(createHunk(alo, ahi, blo, bhi, currRangesRev));
        // start a new hunk
        alo = ahi + size - 2 * context;
        ahi = alo;
        blo = bhi + size - 2 * context;
        bhi = blo;
        const tail = Range.same(arr.slice(size - context, size));
        remaining = [tail, ...remaining.slice(idx + 1)];
        idx = 0;
        currRangesRev = [];
      } else {
        currRangesRev = [Range.same(arr), ...currRangesRev];
        ahi = ahi + size;
        bhi = bhi + size;
        idx += 1;
      }
    } else {
      currRangesRev = [range, ...currRangesRev];
      switch (range.kind) {
        case "next": {
          bhi = bhi + range.contents.length;
          break;
        }
        case "prev": {
          ahi = ahi + range.contents.length;
          break;
        }
        case "replace": {
          ahi = ahi + range.prev.length;
          bhi = bhi + range.next.length;
          break;
        }
        case "unified": {
          // Not expected at this point (get_ranges_rev never returns Unified)
          throw new Error("getHunks: unexpected Unified range");
        }
      }
      idx += 1;
    }
  }
  // No more remaining: finish the last hunk.
  accHunks.push(createHunk(alo, ahi, blo, bhi, currRangesRev));
  return accHunks;
}

function matchRatioFromOps<Elt>(ops: EltOps<Elt>, a: ReadonlyArray<Elt>, b: ReadonlyArray<Elt>): number {
  const ms = matches(ops, a, b);
  return (ms.length * 2) / (a.length + b.length);
}

// ===== merge =====
function collapseMultiSequences(ms: number[][]): Array<[number[], number]> {
  if (ms.length === 0) return [];
  const collapsed: Array<[number[], number]> = [];
  const first = ms[0]!;
  const start: Array<number | undefined> = new Array(first.length).fill(undefined);
  let length = 0;
  for (const il of ms) {
    const allStartSet = start.every((s) => s !== undefined);
    const matchesContinuation = allStartSet && il.every((x, i) => x === (start[i] as number) + length);
    if (matchesContinuation) {
      length += 1;
    } else {
      if (allStartSet) {
        collapsed.push([start.slice() as number[], length]);
      }
      for (let i = 0; i < il.length; i++) start[i] = il[i];
      length = 1;
    }
  }
  if (start.every((s) => s !== undefined) && length !== 0) {
    collapsed.push([start.slice() as number[], length]);
  }
  return collapsed;
}

function mergeFromOps<Elt>(ops: EltOps<Elt>, ar: ReadonlyArray<ReadonlyArray<Elt>>): MergedArray<Elt> {
  if (ar.length === 0) return [];
  if (ar.length === 1) {
    return [{ kind: "same", contents: [...ar[0]!] }];
  }
  const matchesArr: Array<Array<[number, number]>> = [];
  for (let k = 1; k < ar.length; k++) {
    matchesArr.push(matches(ops, ar[0]!, ar[k]!));
  }
  const len = ar.length;
  const ht = new Map<number, Array<[number, number]>>();
  matchesArr.forEach((ms, i) => {
    for (const [a, b] of ms) {
      const cur = ht.get(a);
      if (cur === undefined) {
        ht.set(a, [[i, b]]);
      } else {
        cur.unshift([i, b]);
      }
    }
  });
  // Build list of [a, ...bs] only for keys that have matches in every doc.
  const list: number[][] = [];
  for (const [a, l] of ht.entries()) {
    if (l.length === len - 1) {
      l.sort((p, q) => {
        const d = p[0] - q[0];
        if (d !== 0) return d;
        return p[1] - q[1];
      });
      list.push([a, ...l.map(([, b]) => b)]);
    }
  }
  list.sort((p, q) => {
    const n = Math.min(p.length, q.length);
    for (let i = 0; i < n; i++) {
      const d = p[i]! - q[i]!;
      if (d !== 0) return d;
    }
    return p.length - q.length;
  });
  const matchingBlocks = collapseMultiSequences(list);
  const lastPos: number[] = new Array(ar.length).fill(0);
  const out: MergedArray<Elt> = [];
  for (const [l, blockLen] of matchingBlocks) {
    const arr = l;
    const equal = lastPos.length === arr.length && lastPos.every((v, i) => v === arr[i]);
    if (!equal) {
      const diffs: Elt[][] = [];
      for (let i = 0; i < lastPos.length; i++) {
        diffs.push(slice(ar[i]!, lastPos[i]!, arr[i]!));
      }
      out.push({ kind: "different", contents: diffs });
    }
    out.push({
      kind: "same",
      contents: slice(ar[0]!, arr[0]!, arr[0]! + blockLen),
    });
    for (let i = 0; i < lastPos.length; i++) {
      lastPos[i] = arr[i]! + blockLen;
    }
  }
  const trailing = lastPos.some((lp, i) => ar[i]!.length > lp);
  if (trailing) {
    const diffs: Elt[][] = [];
    for (let i = 0; i < lastPos.length; i++) {
      diffs.push(slice(ar[i]!, lastPos[i]!, ar[i]!.length));
    }
    out.push({ kind: "different", contents: diffs });
  }
  return out;
}

// ===== Generic Make-like factory =====
export type PatienceDiffApi<Elt> = {
  getMatchingBlocks: <A>(args: GetMatchingBlocksArgs<A, Elt>) => MatchingBlock[];
  matches: (a: ReadonlyArray<Elt>, b: ReadonlyArray<Elt>) => Array<[number, number]>;
  matchRatio: (a: ReadonlyArray<Elt>, b: ReadonlyArray<Elt>) => number;
  getHunks: <A>(args: GetHunksArgs<A, Elt>) => Hunk<A>[];
  merge: (ar: ReadonlyArray<ReadonlyArray<Elt>>) => MergedArray<Elt>;
};

export function make<Elt>(ops: EltOps<Elt>): PatienceDiffApi<Elt> {
  return {
    getMatchingBlocks: (args) => getMatchingBlocksFromOps(ops, args),
    matches: (a, b) => matches(ops, a, b),
    matchRatio: (a, b) => matchRatioFromOps(ops, a, b),
    getHunks: (args) => getHunksFromOps(ops, args),
    merge: (ar) => mergeFromOps(ops, ar),
  };
}

// ===== String specialization =====
const stringOps: EltOps<string> = {
  compare: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  hash: (x) => x,
};

export const String: PatienceDiffApi<string> = make<string>(stringOps);

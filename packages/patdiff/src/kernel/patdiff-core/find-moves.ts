/** [findMoves] — detect added/removed line blocks that look like moves and re-classify
 *  them with [Move]/[WithinMove] kinds. Mirrors OCaml's [find_moves]. */

import { MoveId } from "../../patience-diff/move-id.js";
import { MoveKind } from "../../patience-diff/move-kind.js";
import * as PatienceDiff from "../../patience-diff/patience-diff.js";
import { Range } from "../../patience-diff/range.js";
import type { Hunks } from "../hunks.js";
import { scoreLine } from "./score.js";
import { removeWs, strip } from "./word-split.js";

type RangeInfo = {
  readonly rangeIndex: number;
  readonly sizeOfRange: number;
  readonly replaceId: number | undefined;
};

type RangeType =
  | { readonly kind: "original" }
  | { readonly kind: "formerReplace"; readonly id: number }
  | { readonly kind: "move" };

type RangeWithReplacesInfo = {
  readonly hunkIndex: number;
  readonly rangeType: RangeType;
};

const identity = <T>(x: T): T => x;

export type FindMovesArgs = {
  readonly lineBigEnough: number;
  readonly keepWs: boolean;
  readonly hunks: Hunks;
};

const MIN_MATCH_PERC = 0.7;
const MIN_LINES = 3;

const sumLengths = (arr: readonly string[]): number => {
  let s = 0;
  for (const x of arr) s += x.length;
  return s;
};

// Binary search [arr] for the rightmost element whose [sizeOfRange] is <= target's
// [sizeOfRange]. Returns index in [0, arr.length-1] or -1 if all are larger.
const binarySearchLastLessOrEqual = (
  arr: ReadonlyArray<readonly [RangeInfo, readonly string[]]>,
  target: RangeInfo,
): number => {
  let lo = 0;
  let hi = arr.length;
  // Find first index whose size > target.size; the answer is index - 1.
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]![0].sizeOfRange > target.sizeOfRange) hi = mid;
    else lo = mid + 1;
  }
  return lo - 1;
};

export const findMoves = (args: FindMovesArgs): Hunks => {
  const { lineBigEnough, keepWs, hunks } = args;
  // Step 1: flatten ranges, splitting [Replace] into [Prev] + [Next] with a shared
  // [formerReplace] id.
  const allRanges: Array<readonly [RangeWithReplacesInfo, Range<string>]> = [];
  let replaceId = 0;
  hunks.forEach((hunk, hunkIndex) => {
    for (const range of hunk.ranges) {
      if (range.kind === "replace" && range.moveId === undefined) {
        const rt: RangeType = { kind: "formerReplace", id: replaceId };
        allRanges.push([{ hunkIndex, rangeType: rt }, Range.prev(range.prev)]);
        allRanges.push([{ hunkIndex, rangeType: rt }, Range.next(range.next)]);
        replaceId++;
      } else {
        allRanges.push([{ hunkIndex, rangeType: { kind: "original" } }, range]);
      }
    }
  });

  // Step 2: collect candidate Prev/Next ranges (size >= MIN_LINES, no moveKind).
  const prevRanges: Array<readonly [RangeInfo, readonly string[]]> = [];
  const nextRangesUnsorted: Array<readonly [RangeInfo, readonly string[]]> = [];
  allRanges.forEach((entry, rangeIndex) => {
    const [info, range] = entry;
    const rid = info.rangeType.kind === "formerReplace" ? info.rangeType.id : undefined;
    if (range.kind === "prev" && range.moveKind === undefined && range.contents.length >= MIN_LINES) {
      prevRanges.push([
        {
          rangeIndex,
          sizeOfRange: sumLengths(range.contents),
          replaceId: rid,
        },
        range.contents,
      ]);
    } else if (range.kind === "next" && range.moveKind === undefined && range.contents.length >= MIN_LINES) {
      nextRangesUnsorted.push([
        {
          rangeIndex,
          sizeOfRange: sumLengths(range.contents),
          replaceId: rid,
        },
        range.contents,
      ]);
    }
  });

  // Bail out if too expensive.
  if (prevRanges.length * nextRangesUnsorted.length > 40_000) {
    return hunks;
  }

  // Sort next ranges by sizeOfRange asc, then by rangeIndex (Pairing_heap stable order
  // isn't guaranteed in OCaml either, but we use rangeIndex to be deterministic). We
  // use binary search by size only.
  const nextRanges = nextRangesUnsorted.slice().sort((a, b) => {
    const d = a[0].sizeOfRange - b[0].sizeOfRange;
    if (d !== 0) return d;
    return a[0].rangeIndex - b[0].rangeIndex;
  });

  type SelectHunkInfo = {
    readonly moveIndex: MoveId;
    readonly begLinesToTrim: number | undefined;
    readonly endLinesToTrim: number | undefined;
  };
  const prevsUsed = new Map<number, SelectHunkInfo>();
  const nextsToReplace = new Map<number, Range<string>[]>();

  let moveId = MoveId.zero;

  for (const [prevLocation, prevContents] of prevRanges) {
    const startingIndex = (() => {
      const idx = binarySearchLastLessOrEqual(nextRanges, prevLocation);
      if (idx < 0) return 0;
      return idx;
    })();
    let leftIndex = startingIndex;
    let rightIndex = startingIndex + 1;

    const maxSimilarity = (a: RangeInfo, b: RangeInfo): number => {
      const as = a.sizeOfRange;
      const bs = b.sizeOfRange;
      return Math.min(as, bs) / Math.max(as, bs);
    };

    const nextClosestRange = (): readonly [RangeInfo, readonly string[]] | undefined => {
      const left = leftIndex < 0 || leftIndex >= nextRanges.length ? undefined : nextRanges[leftIndex]!;
      const right = rightIndex < 0 || rightIndex >= nextRanges.length ? undefined : nextRanges[rightIndex]!;
      if (left === undefined && right === undefined) return undefined;
      if (left !== undefined && right === undefined) {
        leftIndex--;
        return left;
      }
      if (left === undefined && right !== undefined) {
        rightIndex++;
        return right;
      }
      const [leftInfo] = left!;
      const [rightInfo] = right!;
      if (maxSimilarity(leftInfo, prevLocation) >= maxSimilarity(rightInfo, prevLocation)) {
        leftIndex--;
        return left;
      }
      rightIndex++;
      return right;
    };

    type BestMatch = readonly [number, () => void] | undefined;

    const findBestNextRange = (): void => {
      let best: BestMatch;
      // Loop manually replacing OCaml's recursion.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const closest = nextClosestRange();
        if (closest === undefined) break;
        const [nextLocation, nextContents] = closest;
        const ms = maxSimilarity(prevLocation, nextLocation);
        if (ms < MIN_MATCH_PERC || (best !== undefined && ms < best[0])) {
          break;
        }
        if (
          nextsToReplace.has(nextLocation.rangeIndex) ||
          (nextLocation.replaceId !== undefined &&
            prevLocation.replaceId !== undefined &&
            nextLocation.replaceId === prevLocation.replaceId)
        ) {
          continue;
        }
        const stripped = (arr: readonly string[]): readonly string[] => arr.map(strip);
        const matchRatio = PatienceDiff.String.matchRatio(stripped(prevContents), stripped(nextContents));
        const selectHunk = (): void => {
          // Compute a singleton hunk for this prev/next pair.
          const transform = keepWs ? identity : removeWs;
          const innerHunks = PatienceDiff.String.getHunks<string>({
            transform,
            context: -1,
            bigEnough: lineBigEnough,
            maxSlide: 100,
            score: scoreLine,
            prev: prevContents,
            next: nextContents,
          });
          const hunk = innerHunks[0]!;
          const moveIndex = moveId;
          prevsUsed.set(prevLocation.rangeIndex, {
            moveIndex,
            begLinesToTrim: undefined,
            endLinesToTrim: undefined,
          });
          moveId = MoveId.succ(moveId);
          const numRanges = hunk.ranges.length;
          const isOnEdge = (i: number): boolean => i === 0 || i === numRanges - 1;
          const replacement: Range<string>[] = [];
          hunk.ranges.forEach((range, rangeIndexWithinMove) => {
            switch (range.kind) {
              case "same": {
                // Project the right-hand side of the (prev, next) tuples.
                const nextOnly = range.contents.map(([, n]) => n);
                replacement.push(Range.next(nextOnly, MoveKind.move(moveIndex)));
                break;
              }
              case "replace": {
                replacement.push(Range.replace(range.prev, range.next, moveIndex));
                break;
              }
              case "prev": {
                if (isOnEdge(rangeIndexWithinMove)) {
                  // Trim from the prev_used record.
                  const cur = prevsUsed.get(prevLocation.rangeIndex)!;
                  prevsUsed.set(prevLocation.rangeIndex, {
                    moveIndex: cur.moveIndex,
                    begLinesToTrim: rangeIndexWithinMove === 0 ? range.contents.length : cur.begLinesToTrim,
                    endLinesToTrim: rangeIndexWithinMove === numRanges - 1 ? range.contents.length : cur.endLinesToTrim,
                  });
                  // Don't add to replacement.
                } else {
                  replacement.push(Range.prev(range.contents, MoveKind.withinMove(moveIndex)));
                }
                break;
              }
              case "next": {
                const moveKind = isOnEdge(rangeIndexWithinMove) ? undefined : MoveKind.withinMove(moveIndex);
                replacement.push(Range.next(range.contents, moveKind));
                break;
              }
              case "unified": {
                replacement.push(Range.unified(range.contents, moveIndex));
                break;
              }
            }
          });
          nextsToReplace.set(nextLocation.rangeIndex, replacement);
        };

        if (best === undefined) {
          if (matchRatio >= MIN_MATCH_PERC) {
            best = [matchRatio, selectHunk];
          }
        } else if (matchRatio > best[0]) {
          best = [matchRatio, selectHunk];
        }
      }
      if (best !== undefined) {
        best[1]();
      }
    };
    findBestNextRange();
  }

  // Step 3: build the new ranges list.
  const expandedRanges: Array<readonly [RangeWithReplacesInfo, Range<string>]> = [];
  allRanges.forEach(([rangeData, range], rangeIndex) => {
    const prevsHit = prevsUsed.get(rangeIndex);
    const nextsHit = nextsToReplace.get(rangeIndex);
    if (prevsHit !== undefined && nextsHit !== undefined) {
      throw new Error("findMoves: range is both prev and next");
    }
    if (prevsHit === undefined && nextsHit === undefined) {
      expandedRanges.push([rangeData, range]);
      return;
    }
    if (prevsHit !== undefined) {
      if (range.kind !== "prev" || range.moveKind !== undefined) {
        throw new Error("findMoves: expected unmoved Prev range");
      }
      const beg = prevsHit.begLinesToTrim ?? 0;
      const end = prevsHit.endLinesToTrim ?? 0;
      const contents = range.contents;
      if (beg !== 0) {
        expandedRanges.push([
          { hunkIndex: rangeData.hunkIndex, rangeType: { kind: "original" } },
          Range.prev(contents.slice(0, beg)),
        ]);
      }
      expandedRanges.push([
        { hunkIndex: rangeData.hunkIndex, rangeType: { kind: "move" } },
        Range.prev(contents.slice(beg, contents.length - end), MoveKind.move(prevsHit.moveIndex)),
      ]);
      if (end !== 0) {
        expandedRanges.push([
          { hunkIndex: rangeData.hunkIndex, rangeType: { kind: "original" } },
          Range.prev(contents.slice(contents.length - end)),
        ]);
      }
      return;
    }
    // nextsHit !== undefined
    const moveData: RangeWithReplacesInfo = {
      hunkIndex: rangeData.hunkIndex,
      rangeType: { kind: "move" },
    };
    for (const r of nextsHit!) {
      expandedRanges.push([moveData, r]);
    }
  });

  // Step 4: recover [Replace] ranges that weren't used as moves.
  const finalRanges: Array<readonly [RangeWithReplacesInfo, Range<string>]> = [];
  let i = 0;
  while (i < expandedRanges.length) {
    const cur = expandedRanges[i]!;
    const next = expandedRanges[i + 1];
    if (
      cur[0].rangeType.kind === "formerReplace" &&
      next !== undefined &&
      next[0].rangeType.kind === "formerReplace" &&
      cur[1].kind === "prev" &&
      cur[1].moveKind === undefined &&
      next[1].kind === "next" &&
      next[1].moveKind === undefined
    ) {
      finalRanges.push([
        {
          hunkIndex: cur[0].hunkIndex,
          rangeType: { kind: "original" },
        },
        Range.replace(cur[1].contents, next[1].contents),
      ]);
      i += 2;
    } else {
      finalRanges.push(cur);
      i += 1;
    }
  }

  // Step 5: re-bucket ranges by their original hunk indexes.
  // Walk [finalRanges] with a cursor (O(n) total) rather than [shift()]ing
  // (O(n^2)). Mirrors OCaml's [Queue.drain]: consume from the front while
  // [hunkIndex] matches.
  let cursor = 0;
  const finalHunks: Hunks = hunks.map((hunk, hunkIndex) => {
    const ranges: Range<string>[] = [];
    while (cursor < finalRanges.length && finalRanges[cursor]![0].hunkIndex === hunkIndex) {
      ranges.push(finalRanges[cursor]![1]);
      cursor += 1;
    }
    return { ...hunk, ranges };
  });
  return finalHunks;
};

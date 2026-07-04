import { Range } from "./range.js";

/** In diff terms, a hunk is a unit of consecutive ranges with some [Same] context before
    and after [Next], [Prev], and [Replace] ranges. Each hunk contains information about
    the original arrays, specifically the starting indexes and the number of elements in
    both arrays to which the hunk refers.

    Furthermore, a diff is essentially a list of hunks. The simplest case is a diff with
    infinite context, consisting of exactly one hunk. */
export type Hunk<T> = {
  readonly prevStart: number;
  readonly prevSize: number;
  readonly nextStart: number;
  readonly nextSize: number;
  readonly ranges: readonly Range<T>[];
};

export const Hunk = {
  /** Returns true if [hunk] contains only Same ranges. */
  allSame<T>(hunk: Hunk<T>): boolean {
    return Range.allSame(hunk.ranges);
  },

  /** Applies a concatMap on [hunk.ranges]. */
  concatMap<T, U>(hunk: Hunk<T>, f: (range: Range<T>) => Range<U>[]): Hunk<U> {
    return {
      prevStart: hunk.prevStart,
      prevSize: hunk.prevSize,
      nextStart: hunk.nextStart,
      nextSize: hunk.nextSize,
      ranges: hunk.ranges.flatMap(f),
    };
  },

  /** Take a hunk that was generated with infinite context and limit it to the provided
      [context]. */
  limitInfiniteContextHunkToContext<T>(hunk: Hunk<T>, context: number): Hunk<T>[] {
    type TrimResult<U> =
      | { tag: "didNotTrim"; range: Range<U> }
      | {
          tag: "trimmed";
          linesTrimmed: number;
          startRange: Range<U>;
          endRange: Range<U>;
        };

    const trimRange = (range: Range<T>): TrimResult<T> => {
      if (range.kind === "same") {
        const len = range.contents.length;
        if (len <= context) {
          return { tag: "didNotTrim", range };
        }
        const start = Range.same(range.contents.slice(0, context));
        const end = Range.same(range.contents.slice(len - context, len));
        const linesTrimmed = len - 2 * context;
        return { tag: "trimmed", linesTrimmed, startRange: start, endRange: end };
      }
      return { tag: "didNotTrim", range };
    };

    let workingRanges: Range<T>[] = [];
    let workingRangesOffsetFromPrevious = 0;
    const allHunks: Array<[number, Range<T>[]]> = [];
    const finishHunk = (offsetFromPreviousEnd: number): void => {
      allHunks.push([workingRangesOffsetFromPrevious, workingRanges]);
      workingRanges = [];
      workingRangesOffsetFromPrevious = offsetFromPreviousEnd;
    };

    const lastRangeIndex = hunk.ranges.length - 1;
    hunk.ranges.forEach((range, i) => {
      const trimmed = trimRange(range);
      if (trimmed.tag === "didNotTrim") {
        workingRanges.push(trimmed.range);
        if (i === lastRangeIndex) finishHunk(0);
      } else {
        const { linesTrimmed, startRange, endRange } = trimmed;
        if (i === 0) {
          workingRangesOffsetFromPrevious = linesTrimmed + Range.prevSize(startRange);
          workingRanges.push(endRange);
        } else if (i === lastRangeIndex) {
          workingRanges.push(startRange);
          finishHunk(0);
        } else if (linesTrimmed > 0) {
          workingRanges.push(startRange);
          finishHunk(linesTrimmed);
          workingRanges.push(endRange);
        } else {
          workingRanges.push(range);
        }
      }
    });

    let prevEnd = 1;
    let nextEnd = 1;
    const result: Hunk<T>[] = [];
    for (const [offsetFromPrevious, ranges] of allHunks) {
      if (ranges.length === 0) continue;
      const prevSize = ranges.reduce((s, r) => s + Range.prevSize(r), 0);
      const nextSize = ranges.reduce((s, r) => s + Range.nextSize(r), 0);
      const h: Hunk<T> = {
        ranges,
        prevStart: prevEnd + offsetFromPrevious,
        prevSize,
        nextStart: nextEnd + offsetFromPrevious,
        nextSize,
      };
      prevEnd = h.prevSize + h.prevStart;
      nextEnd = h.nextSize + h.nextStart;
      result.push(h);
    }
    return result;
  },
};

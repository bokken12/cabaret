import { Hunk } from "./hunk.js";
import { Range } from "./range.js";

export type Hunks<T> = readonly Hunk<T>[];

export const Hunks = {
  concatMapRanges<T, U>(hunks: Hunks<T>, f: (range: Range<T>) => Range<U>[]): Hunks<U> {
    return hunks.map((h) => Hunk.concatMap(h, f));
  },

  /** Converts all Replace ranges in [hunks] to a Prev range followed by a Next range. */
  unified<T>(hunks: Hunks<T>): Hunks<T> {
    return Hunks.concatMapRanges<T, T>(hunks, (range) => {
      if (range.kind === "replace") {
        const moveKind =
          range.moveId !== undefined ? ({ kind: "withinMove", moveId: range.moveId } as const) : undefined;
        return [Range.prev(range.prev, moveKind), Range.next(range.next, moveKind)];
      }
      return [range];
    });
  },

  /** Concatenates all the ranges of all hunks together. */
  ranges<T>(hunks: Hunks<T>): Range<T>[] {
    return hunks.flatMap((h) => h.ranges);
  },
};

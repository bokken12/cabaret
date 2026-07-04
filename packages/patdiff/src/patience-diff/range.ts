import type { MoveId } from "./move-id.js";
import type { MoveKind } from "./move-kind.js";

/** For handling diffs abstractly. A range is a subarray of the two original arrays with a
    constructor defining its relationship to the two original arrays. A [Same] range
    contains a series of elements which can be found in both arrays. A [Next] range
    contains elements found only in the second array, while a [Prev] range contains
    elements found only in the first array.

    If a range is part of a move it will have a non-undefined [MoveKind] or [MoveId] in
    the case of [Replace] and [Unified]. A [Prev] with a [Move _] [MoveKind] means that
    [Prev] has a corresponding [Next] that it was moved to. A [Prev] with a
    [WithinMove _] [MoveKind] means that this was some code that was deleted within a
    block that moved to a [Next] position of the file. If a [Replace] or [Unified] range
    is associated with a move it can only be change within a move so they only have a
    [MoveId] instead of a [MoveKind] like [Prev] or [Next]. */
export type Range<T> =
  | { kind: "same"; contents: ReadonlyArray<readonly [T, T]> }
  | { kind: "prev"; contents: ReadonlyArray<T>; moveKind?: MoveKind }
  | { kind: "next"; contents: ReadonlyArray<T>; moveKind?: MoveKind }
  | {
      kind: "replace";
      prev: ReadonlyArray<T>;
      next: ReadonlyArray<T>;
      moveId?: MoveId;
    }
  | { kind: "unified"; contents: ReadonlyArray<T>; moveId?: MoveId };

export const Range = {
  same<T>(contents: ReadonlyArray<readonly [T, T]>): Range<T> {
    return { kind: "same", contents };
  },
  prev<T>(contents: ReadonlyArray<T>, moveKind?: MoveKind): Range<T> {
    return moveKind === undefined ? { kind: "prev", contents } : { kind: "prev", contents, moveKind };
  },
  next<T>(contents: ReadonlyArray<T>, moveKind?: MoveKind): Range<T> {
    return moveKind === undefined ? { kind: "next", contents } : { kind: "next", contents, moveKind };
  },
  replace<T>(prev: ReadonlyArray<T>, next: ReadonlyArray<T>, moveId?: MoveId): Range<T> {
    return moveId === undefined ? { kind: "replace", prev, next } : { kind: "replace", prev, next, moveId };
  },
  unified<T>(contents: ReadonlyArray<T>, moveId?: MoveId): Range<T> {
    return moveId === undefined ? { kind: "unified", contents } : { kind: "unified", contents, moveId };
  },

  /** Returns true if all [ranges] are Same */
  allSame<T>(ranges: ReadonlyArray<Range<T>>): boolean {
    return ranges.every((r) => r.kind === "same");
  },

  /** Counts number of prev elements. */
  prevSize<T>(range: Range<T>): number {
    switch (range.kind) {
      case "same":
        return range.contents.length;
      case "prev":
        if (range.moveKind === undefined || range.moveKind.kind === "move") {
          return range.contents.length;
        }
        return 0;
      case "next":
        return 0;
      case "replace":
        return range.moveId === undefined ? range.prev.length : 0;
      case "unified":
        return range.moveId === undefined ? range.contents.length : 0;
    }
  },

  nextSize<T>(range: Range<T>): number {
    switch (range.kind) {
      case "same":
        return range.contents.length;
      case "prev":
        return 0;
      case "next":
        return range.contents.length;
      case "replace":
        return range.next.length;
      case "unified":
        return range.contents.length;
    }
  },

  /** [prevOnly ranges] drops all Next ranges and converts all Replace ranges to Prev
      ranges. */
  prevOnly<T>(ranges: ReadonlyArray<Range<T>>): Range<T>[] {
    return ranges.flatMap((range) => prevAndNext(range)[0]);
  },

  /** [nextOnly ranges] drops all Prev ranges and converts all Replace ranges to Next
      ranges. */
  nextOnly<T>(ranges: ReadonlyArray<Range<T>>): Range<T>[] {
    return ranges.flatMap((range) => prevAndNext(range)[1]);
  },
};

function prevAndNext<T>(range: Range<T>): [Range<T>[], Range<T>[]] {
  switch (range.kind) {
    case "same":
      return [[range], [range]];
    case "prev":
      if (range.moveKind === undefined || range.moveKind.kind === "move") {
        return [[range], []];
      }
      // WithinMove: don't include — represents code deleted from a different Prev to
      // create a corresponding Next.
      return [[], []];
    case "next":
      return [[], [range]];
    case "replace":
      if (range.moveId === undefined) {
        return [[{ kind: "prev", contents: range.prev }], [{ kind: "next", contents: range.next }]];
      }
      return [
        [],
        [
          {
            kind: "next",
            contents: range.next,
            moveKind: { kind: "withinMove", moveId: range.moveId },
          },
        ],
      ];
    case "unified":
      if (range.moveId === undefined) {
        return [[range], [range]];
      }
      return [[], [range]];
  }
}

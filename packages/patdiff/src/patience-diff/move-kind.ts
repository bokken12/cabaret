import type { MoveId } from "./move-id.js";

/** If a given range is part of a move it will have a [MoveKind]. If the move is simple
    with no ranges there will just be two ranges: One [Prev] and one [Next] that share the
    same [Move MOVE_INDEX] where the index is used to identify a given move as the same.

    If the move has modifications like additions and deletions then the [Next] part of the
    move will have replaces with [Within_move MOVE_INDEX] to denote they are just
    modifications to the moved code. */
export type MoveKind = { kind: "move"; moveId: MoveId } | { kind: "withinMove"; moveId: MoveId };

export const MoveKind = {
  move: (moveId: MoveId): MoveKind => ({ kind: "move", moveId }),
  withinMove: (moveId: MoveId): MoveKind => ({ kind: "withinMove", moveId }),
};

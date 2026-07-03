/** Sexp helpers for translating OCaml [%sexp] expected outputs.
 *
 *  Each [hunksToSexp] / [structuredHunksToSexp] mirrors OCaml's derived sexp
 *  printer for [Hunk.t list], shape-for-shape. Pretty-printing mimics
 *  [Sexp.to_string_hum] for the common test shapes; minor cosmetic drift may
 *  occur on deeply nested values. */

import type { Hunk } from "../patience-diff/hunk.js";
import type { MoveKind } from "../patience-diff/move-kind.js";
import type { Range } from "../patience-diff/range.js";
import { atom, list, printSexp, type Sexp } from "../shared/sexp.js";
import type { StructuredHunks, StructuredLine } from "./patdiff-core-types.js";

const moveKindToSexp = (mk: MoveKind): Sexp => {
  switch (mk.kind) {
    case "move":
      return list([atom("Move"), atom(String(mk.moveId))]);
    case "withinMove":
      return list([atom("Within_move"), atom(String(mk.moveId))]);
  }
};

const moveIdOptionToSexp = (id: number | undefined): Sexp => (id === undefined ? list([]) : list([atom(String(id))]));

const moveKindOptionToSexp = (mk: MoveKind | undefined): Sexp =>
  mk === undefined ? list([]) : list([moveKindToSexp(mk)]);

const rangeOfStringToSexp = (r: Range<string>): Sexp => {
  switch (r.kind) {
    case "same":
      return list([atom("Same"), list(r.contents.map(([a, b]) => list([atom(a), atom(b)])))]);
    case "prev":
      return list([atom("Prev"), list(r.contents.map(atom)), moveKindOptionToSexp(r.moveKind)]);
    case "next":
      return list([atom("Next"), list(r.contents.map(atom)), moveKindOptionToSexp(r.moveKind)]);
    case "replace":
      return list([atom("Replace"), list(r.prev.map(atom)), list(r.next.map(atom)), moveIdOptionToSexp(r.moveId)]);
    case "unified":
      return list([atom("Unified"), list(r.contents.map(atom)), moveIdOptionToSexp(r.moveId)]);
  }
};

const hunkOfStringToSexp = (h: Hunk<string>): Sexp =>
  list([
    list([atom("prev_start"), atom(String(h.prevStart))]),
    list([atom("prev_size"), atom(String(h.prevSize))]),
    list([atom("next_start"), atom(String(h.nextStart))]),
    list([atom("next_size"), atom(String(h.nextSize))]),
    list([atom("ranges"), list(h.ranges.map(rangeOfStringToSexp))]),
  ]);

export const hunksToSexp = (hunks: readonly Hunk<string>[]): Sexp => list(hunks.map(hunkOfStringToSexp));

const structuredLineToSexp = (l: StructuredLine): Sexp => list([atom(l[0]), atom(l[1])]);

const lineListToSexp = (lines: readonly StructuredLine[]): Sexp => list(lines.map(structuredLineToSexp));

const rangeStructuredToSexp = (r: Range<readonly StructuredLine[]>): Sexp => {
  switch (r.kind) {
    case "same":
      return list([atom("Same"), list(r.contents.map(([a, b]) => list([lineListToSexp(a), lineListToSexp(b)])))]);
    case "prev":
      return list([atom("Prev"), list(r.contents.map(lineListToSexp)), moveKindOptionToSexp(r.moveKind)]);
    case "next":
      return list([atom("Next"), list(r.contents.map(lineListToSexp)), moveKindOptionToSexp(r.moveKind)]);
    case "replace":
      return list([
        atom("Replace"),
        list(r.prev.map(lineListToSexp)),
        list(r.next.map(lineListToSexp)),
        moveIdOptionToSexp(r.moveId),
      ]);
    case "unified":
      return list([atom("Unified"), list(r.contents.map(lineListToSexp)), moveIdOptionToSexp(r.moveId)]);
  }
};

const hunkStructuredToSexp = (h: Hunk<readonly StructuredLine[]>): Sexp =>
  list([
    list([atom("prev_start"), atom(String(h.prevStart))]),
    list([atom("prev_size"), atom(String(h.prevSize))]),
    list([atom("next_start"), atom(String(h.nextStart))]),
    list([atom("next_size"), atom(String(h.nextSize))]),
    list([atom("ranges"), list(h.ranges.map(rangeStructuredToSexp))]),
  ]);

export const structuredHunksToSexp = (hunks: StructuredHunks): Sexp => list(hunks.map(hunkStructuredToSexp));

/** Approximate [Sexp.to_string_hum] flat printing — useful for hunks-as-sexp
 *  snapshot assertions. */
export const printHunksSexp = (hunks: readonly Hunk<string>[]): string => printSexp(hunksToSexp(hunks));

export const printStructuredHunksSexp = (hunks: StructuredHunks): string => printSexp(structuredHunksToSexp(hunks));

/** Returns [Sexp] for any value of [readonly Hunk<string>[]] or
 *  [StructuredHunks] for callers that prefer to compose. */
export { atom, list, printSexp };

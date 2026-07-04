/** One aligned 4-way hunk: a slice of each version plus how the four slices
 *  relate. Ported from Iron's [patdiff4/lib/segment.ml]. */

import * as Diamond from "./diamond.js";
import * as Diff4Class from "./diff4-class.js";
import * as Slice from "./slice.js";

export type Segment = {
  readonly slice: Diamond.Diamond<Slice.Slice>;
  readonly diff4Class: Diff4Class.Diff4Class;
};

export const isShown = (t: Segment): boolean => Diff4Class.isShown(t.diff4Class);

export const prepend = (lines: readonly string[], t: Segment): Segment => ({
  slice: Diamond.map(t.slice, (slice) => Slice.prepend(lines, slice)),
  diff4Class: t.diff4Class,
});

export const append = (t: Segment, lines: readonly string[]): Segment => ({
  slice: Diamond.map(t.slice, (slice) => Slice.append(slice, lines)),
  diff4Class: t.diff4Class,
});

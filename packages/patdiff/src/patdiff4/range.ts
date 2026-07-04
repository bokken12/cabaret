/** A line range within one source file, ported from Iron's
 *  [patdiff4/lib/range.ml]. */

import type * as Header from "./header.js";

export type Range = {
  /** The file the range came from. */
  readonly source: string;
  /** Inclusive. */
  readonly lineStart: number;
  /** Exclusive. */
  readonly lineEnd: number;
};

export const merge = (t1: Range, t2: Range): Range => {
  if (t1.source !== t2.source) {
    throw new Error(`cannot merge ranges of ${t1.source} and ${t2.source}`);
  }
  return {
    source: t1.source,
    lineStart: Math.min(t1.lineStart, t2.lineStart),
    lineEnd: Math.max(t1.lineEnd, t2.lineEnd),
  };
};

export const toHeader = (t: Range, otherNames: readonly string[]): Header.Source => ({
  name: t.source,
  otherNames,
  range: [t.lineStart, t.lineEnd],
});

export const prepend = (lines: number, t: Range): Range => ({
  ...t,
  lineStart: Math.max(0, t.lineStart - lines),
});

export const append = (t: Range, lines: number): Range => ({ ...t, lineEnd: t.lineEnd + lines });

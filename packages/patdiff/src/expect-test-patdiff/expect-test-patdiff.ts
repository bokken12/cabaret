/** TypeScript port of [Expect_test_patdiff].
 *
 *  Helpers for diffing strings (or sexps) inside expect tests. The OCaml library
 *  writes its result to stdout; the TS port exposes both:
 *
 *    - {@link diffToString}   - returns the diff as a string (for use with
 *                               vitest's [toMatchInlineSnapshot])
 *    - {@link printDiff}      - writes the diff to stdout, like OCaml does
 *
 *  All diffing is done in [Ascii] mode with [produceUnifiedLines=false] and
 *  [splitLongLines=false] to match the OCaml behavior. */

import type * as Format from "../kernel/format.js";
import { withoutUnix } from "../kernel/patdiff-core.js";
import type { Percent } from "../shared/percent.js";
import type { Sexp } from "../shared/sexp.js";
import { printSexp } from "../shared/sexp.js";

/** Options accepted by every public function in this module. They mirror the
 *  OCaml optional arguments one-for-one. */
export type PatdiffOptions = {
  readonly context?: number;
  readonly findMoves?: boolean;
  readonly floatTolerance?: Percent;
  readonly interleave?: boolean;
  readonly keepWs?: boolean;
  readonly lineBigEnough?: number;
  /** Defaults to [Separator] - matches the OCaml [print_patdiff] default. */
  readonly locationStyle?: Format.LocationStyle;
  readonly printGlobalHeader?: boolean;
  readonly rules?: Format.Rules;
  readonly wordBigEnough?: number;
};

const runPatdiff = (opts: PatdiffOptions, prev: string, next: string): string =>
  withoutUnix.patdiff({
    ...(opts.context !== undefined ? { context: opts.context } : {}),
    ...(opts.findMoves !== undefined ? { findMoves: opts.findMoves } : {}),
    ...(opts.floatTolerance !== undefined ? { floatTolerance: opts.floatTolerance } : {}),
    ...(opts.interleave !== undefined ? { interleave: opts.interleave } : {}),
    ...(opts.keepWs !== undefined ? { keepWs: opts.keepWs } : {}),
    ...(opts.lineBigEnough !== undefined ? { lineBigEnough: opts.lineBigEnough } : {}),
    locationStyle: opts.locationStyle ?? "Separator",
    ...(opts.printGlobalHeader !== undefined ? { printGlobalHeader: opts.printGlobalHeader } : {}),
    ...(opts.rules !== undefined ? { rules: opts.rules } : {}),
    ...(opts.wordBigEnough !== undefined ? { wordBigEnough: opts.wordBigEnough } : {}),
    output: "Ascii",
    produceUnifiedLines: false,
    splitLongLines: false,
    prev: { name: "a", text: prev },
    next: { name: "b", text: next },
  });

/** {@link patdiff} - compute an ASCII diff between two strings. Mirrors OCaml's
 *  [Expect_test_patdiff.patdiff]. Returns the empty string for identical input. */
export const patdiff = (opts: PatdiffOptions, prev: string, next: string): string => runPatdiff(opts, prev, next);

/** {@link patdiffS} - like {@link patdiff}, but for sexps. The sexps are
 *  rendered to strings via {@link sexpToString} before being diffed.
 *
 *  Note: OCaml uses [Sexp.to_string_hum] (a column-aligning pretty-printer)
 *  here. Our [printSexp] is the single-line variant. The diff *behavior* is
 *  identical; only the visual layout of the inputs differs. */
export const patdiffS = (opts: PatdiffOptions, prev: Sexp, next: Sexp): string =>
  runPatdiff(opts, sexpToString(prev), sexpToString(next));

/** Returns the diff between [prev] and [next]. Identical to {@link patdiff};
 *  exposed as a convenience for callers who want an explicit "return as
 *  string" name. */
export const diffToString = (opts: PatdiffOptions, prev: string, next: string): string => runPatdiff(opts, prev, next);

const writeLine = (s: string): void => {
  process.stdout.write(s + "\n");
};

/** {@link printPatdiff} - print the diff between [prev] and [next] to stdout.
 *  Mirrors OCaml's [print_patdiff]. Emits no output (not even a newline) when
 *  the inputs are identical. */
export const printPatdiff = (opts: PatdiffOptions, prev: string, next: string): void => {
  const diff = runPatdiff(opts, prev, next);
  if (diff !== "") writeLine(diff);
};

/** {@link printPatdiffS} - like {@link printPatdiff}, but for sexps. */
export const printPatdiffS = (opts: PatdiffOptions, prev: Sexp, next: Sexp): void =>
  printPatdiff(opts, sexpToString(prev), sexpToString(next));

/** Stateful diff printer. Returns a callback that, on each call, prints the
 *  diff between the previously-seen string and the new one. The first call
 *  prints the full string (no diff).
 *
 *  If [initial] is provided, its full content is printed immediately and it
 *  becomes the "previous" value for the next call. If [initial] is null/
 *  undefined, the first call to the returned function prints the string in
 *  full (no diff) and stores it as "previous".
 *
 *  Mirrors OCaml's [diff_printer] (the [Staged.t] is just a function in TS). */
export const diffPrinter = (opts: PatdiffOptions, initial: string | null | undefined): ((current: string) => void) => {
  let previous: string | null = null;
  const print = (current: string): void => {
    if (previous === null) {
      writeLine(current);
    } else {
      const diff = runPatdiff(opts, previous, current);
      if (diff !== "") writeLine(diff);
    }
    previous = current;
  };
  if (initial !== null && initial !== undefined) print(initial);
  return print;
};

/** Sexp-flavored {@link diffPrinter}. The returned callback takes a [Sexp]; it
 *  is rendered to a string via {@link sexpToString} before being diffed against
 *  the previous one. */
export const diffPrinterS = (opts: PatdiffOptions, initial: Sexp | null | undefined): ((current: Sexp) => void) => {
  const print = diffPrinter(opts, initial !== null && initial !== undefined ? sexpToString(initial) : null);
  return (sexp: Sexp): void => print(sexpToString(sexp));
};

/** Render a sexp to a string. In OCaml this is the multi-line column-aligning
 *  [Sexp.to_string_hum]; here it is the single-line {@link printSexp} we have
 *  in [shared/sexp.ts]. The diff behavior is unaffected by this choice. */
export const sexpToString = (sexp: Sexp): string => printSexp(sexp);

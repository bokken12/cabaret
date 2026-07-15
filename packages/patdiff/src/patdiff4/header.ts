/** Hunk headers and hints for 4-way diffs, ported from Iron's
 *  [patdiff4/lib/header.ml]:
 *
 *  ```
 *  @@@@@@@@ old tip 10,20 new tip 20,30 @@@@@@@@
 *  ```
 *
 *  Iron styles these unconditionally and strips escapes behind a global
 *  ascii-only flag; here every renderer takes the output mode instead. */

import { applyStyles } from "../kernel/ansi-output.js";
import * as Format from "../kernel/format.js";

/** patdiff4 renders to a terminal; HTML has no ddiff rendering. */
export type Output4 = "Ansi" | "Ascii";

const { Attr, Color } = Format;

type Sgr8 = Format.Color.Sgr8.T;

const fg = (name: Sgr8): Format.Style => Attr.Fg(Color.Standard(name));
const bg = (name: Sgr8): Format.Style => Attr.Bg(Color.Standard(name));

const style = (output: Output4, styles: readonly Format.Style[], text: string): string =>
  output === "Ansi" ? applyStyles(styles, text) : text;

export type Source = {
  readonly name: string;
  readonly otherNames: readonly string[];
  /** [start, end), or undefined before hunk breaks are attached. */
  readonly range: readonly [number, number] | undefined;
};

export type Diff2 = { readonly minus: Source; readonly plus: Source };

/** An outer diff of two inner diffs. */
export type Diff4 = { readonly minus: Diff2; readonly plus: Diff2 };

export type Header =
  | { readonly kind: "Diff2"; readonly diff: Diff2 }
  | { readonly kind: "Diff4"; readonly diff: Diff4 };

const sourceAddHunkBreak = (t: Source, [pos, len]: readonly [number, number]): Source => {
  const range: readonly [number, number] =
    t.range === undefined ? [pos, pos + len] : [t.range[0] + pos, t.range[0] + pos + len];
  return { ...t, range };
};

const diff2AddHunkBreak = (t: Diff2, minus: readonly [number, number], plus: readonly [number, number]): Diff2 => ({
  minus: sourceAddHunkBreak(t.minus, minus),
  plus: sourceAddHunkBreak(t.plus, plus),
});

export const addHunkBreak = (t: Header, minus: readonly [number, number], plus: readonly [number, number]): Header => {
  switch (t.kind) {
    case "Diff2":
      return { kind: "Diff2", diff: diff2AddHunkBreak(t.diff, minus, plus) };
    case "Diff4":
      return {
        kind: "Diff4",
        diff: {
          minus: diff2AddHunkBreak(t.diff.minus, minus, plus),
          plus: diff2AddHunkBreak(t.diff.plus, minus, plus),
        },
      };
  }
};

/** Order revision names the way a reader expects, oldest first. */
const sortHeuristic = (names: readonly string[]): readonly string[] => {
  const value = (name: string): number => {
    switch (name) {
      case "old base":
        return 1;
      case "base":
        return 2;
      case "old tip":
        return 3;
      case "new base":
        return 4;
      case "tip":
        return 5;
      case "new tip":
        return 6;
      default:
        return 10;
    }
  };
  return [...names].sort((a, b) => value(a) - value(b) || (a < b ? -1 : a > b ? 1 : 0));
};

const filenameAndLines = (t: Source): readonly [string, string] => {
  const others = sortHeuristic([...new Set(t.otherNames.filter((name) => name !== t.name))].sort());
  // The last name is followed by its range.
  const name = [...others, t.name].join(", ");
  const range = t.range === undefined ? "" : `${t.range[0]},${t.range[1]}`;
  return [name, range];
};

export const separator = (output: Output4): string => style(output, [Attr.Bold, fg("Blue")], "@@@@@@@@");

const center = (size: number, text: string): string => {
  const padded = ` ${text} `;
  const left = Math.max(0, Math.floor((size - padded.length) / 2));
  const right = Math.max(0, size - left - padded.length);
  return "@".repeat(left) + padded + "@".repeat(right);
};

const filenameBarSize = 84;

/** The bar naming the file above its hunks; returns the unstyled length so a
 *  matching separator bar can be built. */
export const filenameHeader = (output: Output4, filename: string): readonly [number, string] => {
  const bar = center(filenameBarSize, filename);
  return [bar.length, style(output, [Attr.Bold, fg("Blue")], bar)];
};

export const filenameSeparator = (output: Output4, length: number): string =>
  style(output, [Attr.Bold, fg("Blue")], "@".repeat(length));

const makeHint = (output: Output4, text: string): string =>
  [separator(output), style(output, [fg("Magenta")], text), separator(output)].join(" ");

export const title = makeHint;

export const hint = {
  b1_b2_f2: "A change in the feature was reverted",
  b1_f1_f2: "A change present only in the new-base was dropped",
  b1_f2__b2_f1: "The same change from the old-tip and the new-base was dropped",
  b1_f2: "Diverging changes in the old-tip and the new-base were both dropped",
  b2_f2_story: ["This feature change was dropped... :", "... in favor of this base change:"],
  f1_f2_story: ["This base change was dropped... :", "... in favor of this feature change:"],
  conflict: "Conflicting changes: the reviewed diff compared to the current diff",
} as const;

export const renderHint = makeHint;

const diff2ToString = (output: Output4, t: Diff2): string => {
  const [minusFile, minusLines] = filenameAndLines(t.minus);
  const [plusFile, plusLines] = filenameAndLines(t.plus);
  return [
    separator(output),
    style(output, [fg("Red")], minusFile),
    style(output, [fg("Blue")], minusLines),
    style(output, [fg("Green")], plusFile),
    style(output, [fg("Blue")], plusLines),
    separator(output),
  ].join(" ");
};

const diff4ToString = (output: Output4, t: Diff4): readonly string[] => {
  const dd = (color: Sgr8): readonly Format.Style[] => [Attr.Bold, bg(color), fg("White")];
  const line = (marker: string, markerStyles: readonly Format.Style[], d: Diff2): string => {
    const [minusFile, minusLines] = filenameAndLines(d.minus);
    const [plusFile, plusLines] = filenameAndLines(d.plus);
    return [
      separator(output),
      style(output, markerStyles, marker),
      style(output, [fg("Red")], minusFile),
      style(output, [fg("Blue")], minusLines),
      style(output, [fg("Green")], plusFile),
      style(output, [fg("Blue")], plusLines),
      separator(output),
    ].join(" ");
  };
  return [line("--", dd("Magenta"), t.minus), line("++", dd("Cyan"), t.plus)];
};

export const toString = (output: Output4, t: Header): readonly string[] => {
  switch (t.kind) {
    case "Diff2":
      return [diff2ToString(output, t.diff)];
    case "Diff4":
      return diff4ToString(output, t.diff);
  }
};

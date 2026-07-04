import * as Style from "./style.js";
import * as StyleRanges from "./style-ranges.js";
import * as Text from "./text.js";
import * as TextWithAnsi from "./text-with-ansi.js";
import type { Element, T as TextWithAnsiT } from "./text-with-ansi-types.js";

export interface T {
  readonly text: Text.T;
  readonly ranges: StyleRanges.T;
}

export const width = (t: T): number => Text.width(t.text);
export const isEmpty = (t: T): boolean => Text.isEmpty(t.text);

export const toTextWithAnsi = (t: T): TextWithAnsiT => {
  const startStyles = t.ranges.map((r) => ({ pos: r.start, style: r.style })).sort((a, b) => a.pos - b.pos);
  const endStyles = t.ranges.map((r) => ({ pos: r.end_, style: Style.turnOff(r.style) })).sort((a, b) => a.pos - b.pos);
  // OCaml List.merge with the same comparator: stable merge
  const merged: { pos: number; style: Style.T }[] = [];
  let i = 0;
  let j = 0;
  while (i < endStyles.length && j < startStyles.length) {
    if (endStyles[i]!.pos <= startStyles[j]!.pos) {
      merged.push(endStyles[i]!);
      i += 1;
    } else {
      merged.push(startStyles[j]!);
      j += 1;
    }
  }
  while (i < endStyles.length) merged.push(endStyles[i++]!);
  while (j < startStyles.length) merged.push(startStyles[j++]!);

  let textWithStylesRev: Element[] = [];
  let textRemaining = t.text;
  let lastPos = 0;
  for (const { pos, style } of merged) {
    const [before, rest] = Text.split(textRemaining, pos - lastPos);
    if (Text.isEmpty(before)) {
      textWithStylesRev = [{ kind: "Style", style }, ...textWithStylesRev];
    } else {
      textWithStylesRev = [{ kind: "Style", style }, { kind: "Text", text: before }, ...textWithStylesRev];
    }
    textRemaining = rest;
    lastPos = pos;
  }
  const final: Element[] = [...textWithStylesRev].reverse();
  final.push({ kind: "Text", text: textRemaining });
  return final;
};

export const ofTextWithAnsi = (textWithAnsi: TextWithAnsiT): T | undefined => {
  const [ranges, unmatched] = StyleRanges.identify(textWithAnsi);
  if (unmatched.length !== 0) return undefined;
  const textParts: Text.T[] = [];
  for (const e of textWithAnsi) {
    if (e.kind === "Text") textParts.push(e.text);
  }
  return { text: Text.concat(textParts), ranges };
};

export const toString = (t: T): string => TextWithAnsi.toString(toTextWithAnsi(t));
export const toStringHum = (t: T): string => TextWithAnsi.toStringHum(toTextWithAnsi(t));
export const toUnstyled = (t: T): string => Text.toString(t.text);

export const unstyleBetween = (start: number, end_: number, t: T): T => ({
  text: t.text,
  ranges: StyleRanges.exclude(start, end_, t.ranges),
});

export const split = (pos: number, t: T): readonly [T, T] => {
  const [textBefore, textAfter] = Text.split(t.text, pos);
  const [rangesBefore, rangesAfter] = StyleRanges.split(pos, t.ranges);
  return [
    { text: textBefore, ranges: rangesBefore },
    { text: textAfter, ranges: rangesAfter },
  ];
};

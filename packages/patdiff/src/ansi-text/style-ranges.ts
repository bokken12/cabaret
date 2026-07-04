import type * as Ansi from "./ansi.js";
import * as Style from "./style.js";
import * as Text from "./text.js";
import type { Element, T as TextWithAnsi } from "./text-with-ansi-types.js";

export interface Range {
  readonly start: number;
  readonly end_: number;
  readonly style: Style.T;
}

export type T = readonly Range[];

const compareRange = (a: Range, b: Range): number => {
  if (a.start !== b.start) return a.start - b.start;
  if (a.end_ !== b.end_) return a.end_ - b.end_;
  return 0;
};

export const identify = (textWithStyles: TextWithAnsi): readonly [T, readonly Ansi.T[]] => {
  let openRanges: { start: number; style: Style.T }[] = [];
  let closedRanges: Range[] = [];
  const otherAnsi: Ansi.T[] = [];
  let width = 0;
  for (const element of textWithStyles) {
    if (element.kind === "Text") {
      width += Text.width(element.text);
      continue;
    }
    if (element.kind === "Style") {
      const newStyle = element.style;
      let foundIdx = -1;
      let foundStart = 0;
      let foundOldStyle: Style.T = [];
      for (let i = 0; i < openRanges.length; i++) {
        const { start, style: oldStyle } = openRanges[i]!;
        if (Style.closes(newStyle, oldStyle)) {
          foundIdx = i;
          foundStart = start;
          foundOldStyle = oldStyle;
          break;
        }
      }
      if (foundIdx < 0) {
        openRanges = [{ start: width, style: newStyle }, ...openRanges];
      } else {
        openRanges = [...openRanges.slice(0, foundIdx), ...openRanges.slice(foundIdx + 1)];
        closedRanges = [{ start: foundStart, end_: width, style: foundOldStyle }, ...closedRanges];
      }
      continue;
    }
    // Other Ansi elements
    otherAnsi.push(element);
  }
  const unmatchedAsAnsi: Ansi.T[] = [];
  // OCaml: List.rev_map unmatched_opens ~f:(fun (_, style) -> `Style style)
  // openRanges is in reverse insertion order; rev_map produces in insertion order
  for (let i = openRanges.length - 1; i >= 0; i--) {
    unmatchedAsAnsi.push({ kind: "Style", style: openRanges[i]!.style });
  }
  // Followed by List.rev other_ansi
  const otherRev: Ansi.T[] = [];
  for (let i = otherAnsi.length - 1; i >= 0; i--) {
    otherRev.push(otherAnsi[i]!);
  }
  const unaccounted = [...unmatchedAsAnsi, ...otherRev];
  const sorted = [...closedRanges].sort(compareRange);
  return [sorted, unaccounted];
};

export const apply = (text: Text.T, t: T): TextWithAnsi => {
  const styles: { pos: number; style: Style.T }[] = [];
  for (const r of t) styles.push({ pos: r.start, style: r.style });
  for (const r of t) styles.push({ pos: r.end_, style: Style.turnOff(r.style) });
  styles.sort((a, b) => a.pos - b.pos);
  const acc: Element[] = [];
  let textRemaining = text;
  let lastPos = 0;
  for (const { pos, style } of styles) {
    if (pos === lastPos) {
      acc.unshift({ kind: "Style", style });
    } else {
      const [before, rest] = Text.split(textRemaining, pos - lastPos);
      // OCaml: acc = `Style :: `Text text_before :: acc — so result list is
      // [Style, Text, ...acc]. We emulate with two unshifts (Text first, then Style).
      acc.unshift({ kind: "Text", text: before });
      acc.unshift({ kind: "Style", style });
      textRemaining = rest;
      lastPos = pos;
    }
  }
  // Reverse the accumulator and append the remaining text
  const reversed = acc.reverse();
  reversed.push({ kind: "Text", text: textRemaining });
  return reversed;
};

export const adjustBy = (t: T, start = 0, end_ = 0): T =>
  t.map((r) => ({
    start: r.start + start,
    end_: r.end_ + end_,
    style: r.style,
  }));

export const exclude = (start: number, end_: number, t: T): T => {
  const result: Range[] = [];
  for (const r of t) {
    const s = r.start;
    const e = r.end_;
    if (start <= s && e <= end_) {
      continue;
    }
    if (s <= start && end_ <= e) {
      result.push({ start: s, end_: start, style: r.style });
      result.push({ start: end_, end_: e, style: r.style });
      continue;
    }
    if (s <= start && start <= e) {
      result.push({ start: s, end_: start, style: r.style });
      continue;
    }
    if (s <= end_ && end_ <= e) {
      result.push({ start: end_, end_: e, style: r.style });
      continue;
    }
    result.push(r);
  }
  return result;
};

export const split = (pos: number, t: T): readonly [T, T] => {
  const before: Range[] = [];
  const after: Range[] = [];
  const across: Range[] = [];
  for (const r of t) {
    if (r.end_ <= pos) {
      before.push(r);
    } else if (r.start >= pos) {
      after.push({ start: r.start - pos, end_: r.end_ - pos, style: r.style });
    } else if (r.start < pos && r.end_ > pos) {
      across.push(r);
    }
  }
  const beforeFinal: Range[] = [...before, ...across.map((r) => ({ start: r.start, end_: pos, style: r.style }))];
  const afterFinal: Range[] = [...across.map((r) => ({ start: 0, end_: r.end_ - pos, style: r.style })), ...after];
  return [beforeFinal, afterFinal];
};

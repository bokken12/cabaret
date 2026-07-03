import * as Ansi from "./ansi.js";
import * as Style from "./style.js";
import * as Text from "./text.js";
import type { Element, T } from "./text-with-ansi-types.js";

export type { Element, T };

export const width = (t: T): number => {
  let acc = 0;
  for (const e of t) {
    if (e.kind === "Text") acc += Text.width(e.text);
  }
  return acc;
};

export const isEmpty = (t: T): boolean => {
  for (const e of t) {
    if (e.kind === "Text" && !Text.isEmpty(e.text)) return false;
  }
  return true;
};

export const toString = (t: T): string => {
  let s = "";
  for (const e of t) {
    if (e.kind === "Text") s += Text.toString(e.text);
    else s += Ansi.toString(e);
  }
  return s;
};

export const toStringHum = (t: T): string => {
  let s = "";
  for (const e of t) {
    if (e.kind === "Text") s += Text.toString(e.text);
    else s += Ansi.toStringHum(e);
  }
  return s;
};

export const toUnstyled = (t: T): string => {
  let s = "";
  for (const e of t) {
    if (e.kind === "Text") s += Text.toString(e.text);
  }
  return s;
};

export const map = (t: T, f: (e: Element) => Element | undefined): T => {
  return t.map((e) => {
    const r = f(e);
    return r !== undefined ? r : e;
  });
};

const isText = (e: Element): e is { kind: "Text"; text: Text.T } => e.kind === "Text";

const compress = (t: T): T => {
  // First pass: filter empty text elements
  const filtered: Element[] = [];
  for (const e of t) {
    if (e.kind === "Text") {
      if (!Text.isEmpty(e.text)) filtered.push(e);
    } else {
      filtered.push(e);
    }
  }
  // Second pass: combine adjacent Text+Text and Style+Style
  const combined: Element[] = [];
  for (const e of filtered) {
    const last = combined[combined.length - 1];
    if (last !== undefined) {
      if (last.kind === "Style" && e.kind === "Style") {
        combined[combined.length - 1] = {
          kind: "Style",
          style: [...last.style, ...e.style],
        };
        continue;
      }
      if (last.kind === "Text" && e.kind === "Text") {
        combined[combined.length - 1] = {
          kind: "Text",
          text: Text.concat2(last.text, e.text),
        };
        continue;
      }
    }
    combined.push(e);
  }
  // Third pass: compress all styles, drop empty styles
  const result: Element[] = [];
  for (const e of combined) {
    if (e.kind === "Style") {
      const sty = Style.compress(e.style);
      if (sty.length > 0) result.push({ kind: "Style", style: sty });
    } else {
      result.push(e);
    }
  }
  return result;
};

export const simplifyStyles = (t: T): T => {
  const compressed = compress(t);
  let oldStyle: Style.T = [];
  const deltas: Element[] = [];
  for (const e of compressed) {
    if (e.kind === "Style") {
      const d = Style.delta(oldStyle, e.style);
      oldStyle = Style.update(oldStyle, e.style);
      deltas.push({ kind: "Style", style: d });
    } else {
      deltas.push(e);
    }
  }
  return compress(deltas);
};

export const styleAtEnd = (t: T): Style.T => {
  let oldStyle: Style.T = [];
  for (const e of t) {
    if (e.kind === "Style") {
      oldStyle = Style.update(oldStyle, e.style);
    }
  }
  return oldStyle;
};

export const split = (pos: number, t: T): readonly [T, T] => {
  let len = 0;
  let idx: number | undefined;
  let lenAtIdx = 0;
  for (let i = 0; i < t.length; i++) {
    const e = t[i]!;
    if (isText(e)) {
      const w = Text.width(e.text);
      if (len + w >= pos) {
        idx = i;
        lenAtIdx = len;
        break;
      }
      len += w;
    }
  }
  if (idx === undefined) {
    return [t, []];
  }
  const atBoundaryEl = t[idx]!;
  const atBoundary = atBoundaryEl.kind === "Text" ? atBoundaryEl.text : Text.ofString("");
  let before: T;
  let after: T;
  if (lenAtIdx + Text.width(atBoundary) === pos) {
    before = t.slice(0, idx + 1);
    after = t.slice(idx + 1);
  } else {
    const [prefix, suffix] = Text.split(atBoundary, pos - lenAtIdx);
    before = [...t.slice(0, idx), { kind: "Text", text: prefix }];
    after = [{ kind: "Text", text: suffix }, ...t.slice(idx + 1)];
  }
  const middleState = styleAtEnd(before);
  const toTurnOn = Style.delta([], middleState);
  before = [...before, { kind: "Style", style: Style.turnOff(toTurnOn) }];
  if (after.length > 0 && after[0]!.kind === "Style" && toTurnOn.length > 0) {
    const head = after[0] as { kind: "Style"; style: Style.T };
    const rest = after.slice(1);
    after = [{ kind: "Style", style: Style.compress([...toTurnOn, ...head.style]) }, ...rest];
  } else if (toTurnOn.length === 0) {
    // unchanged
  } else {
    after = [{ kind: "Style", style: toTurnOn }, ...after];
  }
  return [before, after];
};

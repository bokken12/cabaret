import * as Parser from "./parser.js";
import * as Style from "./style.js";
import * as Text from "./text.js";
import * as TextWithAnsi from "./text-with-ansi.js";
import type { Element, T as TextWithAnsiT } from "./text-with-ansi-types.js";

interface PadOptions {
  char?: string;
  style?: Style.T;
  width: number;
}

const padString = (n: number, ch: string): string => {
  let s = "";
  for (let i = 0; i < n; i++) s += ch;
  return s;
};

export const pad = (t: TextWithAnsiT, opts: PadOptions): TextWithAnsiT => {
  const ch = opts.char ?? " ";
  const style: Style.T = opts.style ?? [];
  const totalWidth = opts.width;
  const padLen = Math.max(0, totalWidth - TextWithAnsi.width(t));
  const padText = Text.ofString(padString(padLen, ch));
  if (style.length === 0) {
    return [...t, { kind: "Text", text: padText }];
  }
  return [
    ...t,
    { kind: "Style", style },
    { kind: "Text", text: padText },
    { kind: "Style", style: Style.turnOff(style) },
  ];
};

export const center = (t: TextWithAnsiT, opts: PadOptions): TextWithAnsiT => {
  const ch = opts.char ?? " ";
  const style: Style.T = opts.style ?? [];
  const totalWidth = opts.width;
  const textWidth = TextWithAnsi.width(t);
  const padLen = Math.max(0, totalWidth - textWidth);
  const leftPad = Text.ofString(padString(Math.floor(padLen / 2), ch));
  const rightPad = Text.ofString(padString(padLen - Math.floor(padLen / 2), ch));
  const leftEl: Element = { kind: "Text", text: leftPad };
  const rightEl: Element = { kind: "Text", text: rightPad };
  if (style.length === 0) {
    return [leftEl, ...t, rightEl];
  }
  const turnOn: Element = { kind: "Style", style };
  const turnOff: Element = { kind: "Style", style: Style.turnOff(style) };
  return [turnOn, leftEl, turnOff, ...t, turnOn, rightEl, turnOff];
};

export const truncate = (t: TextWithAnsiT, opts: { width: number }): TextWithAnsiT =>
  TextWithAnsi.split(opts.width, t)[0];

export const wrap = (t: TextWithAnsiT, opts: { width: number }): readonly TextWithAnsiT[] => {
  const result: TextWithAnsiT[] = [];
  let cur = t;
  while (!TextWithAnsi.isEmpty(cur)) {
    const [before, after] = TextWithAnsi.split(opts.width, cur);
    result.push(before);
    cur = after;
  }
  return result;
};

export const apply = (style: Style.T, str: string): string =>
  Style.toString(style) + str + Style.toString(Style.turnOff(style));

export const visualize = (str: string): string => TextWithAnsi.toStringHum(Parser.parse(str));

export const minimize = (str: string): string => TextWithAnsi.toString(TextWithAnsi.simplifyStyles(Parser.parse(str)));

export const strip = (str: string): string => TextWithAnsi.toUnstyled(Parser.parse(str));

export const toDoubleColumn = (opts: {
  width: number;
  left: string;
  right: string;
}): readonly (readonly [string, string])[] => {
  const width = opts.width;
  const leftLines = wrap(Parser.parse(opts.left), { width }).map((l) => TextWithAnsi.toString(pad(l, { width })));
  const rightLines = wrap(Parser.parse(opts.right), { width }).map((r) => TextWithAnsi.toString(r));
  const leftLen = leftLines.length;
  const rightLen = rightLines.length;
  const linesAddLeft = Math.max(0, rightLen - leftLen);
  const linesAddRight = Math.max(0, leftLen - rightLen);
  for (let i = 0; i < linesAddLeft; i++) leftLines.push(padString(width, " "));
  for (let i = 0; i < linesAddRight; i++) rightLines.push("");
  const result: [string, string][] = [];
  for (let i = 0; i < leftLines.length; i++) {
    result.push([leftLines[i]!, rightLines[i]!]);
  }
  return result;
};

import * as Color from "../ansi-text/color.js";
import { err, isOk, type OrError } from "../shared/result.js";
import * as FileName from "./file-name.js";
import * as Format from "./format.js";
import type { PrintArgs, RuleApplyArgs, S } from "./output.js";

export type Mtime = {
  mtime: (file: FileName.FileName) => OrError<Date>;
};

const stringOfColor = (c: Color.T, background = false): string => {
  switch (c.kind) {
    case "Standard": {
      switch (c.value) {
        case "Black":
          return "#000000";
        case "Red":
          return "#880000";
        case "Green":
          return "#008800";
        case "Yellow":
          return "#888800";
        case "Blue":
          return "#000088";
        case "Magenta":
          return "#880088";
        case "Cyan":
          return "#008888";
        case "White":
          return "#ffffff";
      }
    }
    case "Default":
      return background ? "#000000" : "#ffffff";
    case "Bright": {
      switch (c.value) {
        case "Black":
          return "#c0c0c0";
        case "Red":
          return "#FF0000";
        case "Green":
          return "#00FF00";
        case "Yellow":
          return "#FFFF00";
        case "Blue":
          return "#0000FF";
        case "Magenta":
          return "#FF00FF";
        case "Cyan":
          return "#00FFFF";
        case "White":
          return "#FFFFFF";
      }
    }
    case "Rgb6": {
      const [r, g, b] = Color.Rgb6.toRgb(c.value);
      const scaled = (x: number): number => Math.trunc((x * 255) / 5);
      return `rgb(${scaled(r)},${scaled(g)},${scaled(b)})`;
    }
    case "Gray24": {
      const level = Color.Gray24.toLevel(c.value);
      const scaled = Math.trunc((level * 255) / 23);
      return `rgb(${scaled},${scaled},${scaled})`;
    }
    case "Rgb256": {
      const [r, g, b] = Color.Rgb256.toRgb(c.value);
      return `rgb(${r},${g},${b})`;
    }
  }
};

const applyStyles = (text: string, styles: readonly Format.Style[]): string => {
  let startTags: string[] = [];
  let endTags: string[] = [];
  for (const s of styles) {
    switch (s.kind) {
      case "Bold":
        startTags = [`<span style="font-weight:bold">`, ...startTags];
        endTags = ["</span>", ...endTags];
        break;
      case "Reset":
        break;
      case "Fg":
        startTags = [`<span style="color:${stringOfColor(s.color)}">`, ...startTags];
        endTags = ["</span>", ...endTags];
        break;
      case "Bg":
        startTags = [`<span style="background-color:${stringOfColor(s.color)}">`, ...startTags];
        endTags = ["</span>", ...endTags];
        break;
      case "Underline":
      case "Italic":
        startTags = ["<u>", ...startTags];
        endTags = ["</u>", ...endTags];
        break;
      case "Blink":
        startTags = [`<span style="text-decoration:blink">`, ...startTags];
        endTags = ["</span>", ...endTags];
        break;
      case "Invert":
        break;
      case "Hide":
        startTags = ["<!-- ", ...startTags];
        endTags = [" -->", ...endTags];
        break;
      case "Faint":
        startTags = [`<span style="color:${stringOfColor(Color.Bright("Black"))}">`, ...startTags];
        endTags = ["</span>", ...endTags];
        break;
      default:
        break;
    }
  }
  return [...startTags, text, ...endTags].join("");
};

const htmlEscapeChar = (c: string): string => {
  switch (c) {
    case "<":
      return "&lt;";
    case ">":
      return "&gt;";
    case "&":
      return "&amp;";
    default:
      return c;
  }
};

const htmlEscape = (s: string): string => {
  let out = "";
  for (const c of s) out += htmlEscapeChar(c);
  return out;
};

export const makeApplyRule = (text: string, args: RuleApplyArgs): string => {
  const { rule, refined } = args;
  const middle = refined ? applyStyles(text, [Format.Attr.Reset]) : applyStyles(htmlEscape(text), rule.styles);
  return applyStyles(rule.pre.text, rule.pre.styles) + middle + applyStyles(rule.suf.text, rule.suf.styles);
};

/** Format a [Date] as OCaml's [Time_float.to_string_utc] does:
 *  "YYYY-MM-DD HH:MM:SS.NNNNNNZ" (space separator, 6-digit microseconds, trailing Z).
 *  JS [Date] only has millisecond precision, so the last 3 digits are always "000". */
const toStringUtc = (d: Date): string => {
  const pad = (n: number, w: number): string => n.toString().padStart(w, "0");
  const year = pad(d.getUTCFullYear(), 4);
  const month = pad(d.getUTCMonth() + 1, 2);
  const day = pad(d.getUTCDate(), 2);
  const hour = pad(d.getUTCHours(), 2);
  const minute = pad(d.getUTCMinutes(), 2);
  const second = pad(d.getUTCSeconds(), 2);
  const microseconds = pad(d.getUTCMilliseconds() * 1000, 6);
  return `${year}-${month}-${day} ${hour}:${minute}:${second}.${microseconds}Z`;
};

const printHeader = (
  mtime: Mtime,
  args: {
    rules: Format.Rules;
    fileNames: readonly [FileName.FileName, FileName.FileName];
    print: (s: string) => void;
  },
): void => {
  const [prevFile, nextFile] = args.fileNames;
  const getTime = (f: FileName.FileName): string => {
    const r = mtime.mtime(f);
    if (isOk(r)) return toStringUtc(r.value);
    return "";
  };
  const printLine = (file: FileName.FileName, rule: Format.Rule): void => {
    const t = `${FileName.toStringHum(file)} ${getTime(file)}`;
    args.print(makeApplyRule(t, { rule, refined: false }));
  };
  printLine(prevFile, args.rules.headerPrev);
  printLine(nextFile, args.rules.headerNext);
};

export const make = (mtime: Mtime): S => {
  const printImpl = (a: PrintArgs): void => {
    const { printGlobalHeader, fileNames, rules, print: printer, locationStyle, hunks } = a;
    const [prevFile] = fileNames;
    printer(`<pre style="font-family:consolas,monospace">`);
    if (printGlobalHeader) {
      printHeader(mtime, { rules, fileNames, print: printer });
    }
    for (const hunk of hunks) {
      const line = Format.LocationStyle.sprint({
        style: locationStyle,
        hunk,
        prevFilename: FileName.displayName(prevFile),
        rule: (s) => makeApplyRule(s, { rule: rules.hunk, refined: false }),
      });
      printer(line);
      for (const range of hunk.ranges) {
        switch (range.kind) {
          case "same":
            for (const [, next] of range.contents) printer(next);
            break;
          case "prev":
          case "next":
          case "unified":
            for (const x of range.contents) printer(x);
            break;
          case "replace":
            for (const x of range.prev) printer(x);
            for (const x of range.next) printer(x);
            break;
        }
      }
    }
    printer("</pre>");
  };
  return { applyRule: makeApplyRule, print: printImpl };
};

export const withoutMtime: S = make({
  mtime: () => err(new Error("Mtime implementation not available")),
});

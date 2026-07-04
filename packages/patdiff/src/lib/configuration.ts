/** Configuration loading: parses sexp-based config files and exposes the
 *  Node-flavored [getConfig]/[load]/[saveDefault] helpers.
 *
 *  Translation of OCaml's [Patdiff.Configuration].
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as Attr from "../ansi-text/attr.js";
import * as Color from "../ansi-text/color.js";
import {
  type Configuration,
  createExn,
  defaultConfiguration,
  defaultContext,
  defaultLineBigEnough,
  defaultWordBigEnough,
  type SideBySide,
  warnIfNoTrailingNewlineInBothDefault,
} from "../kernel/configuration.js";
import * as Format from "../kernel/format.js";
import type { Output } from "../kernel/output.js";
import { atom, list, parseSexp, printSexp, type Sexp } from "../shared/sexp.js";

export * from "../kernel/configuration.js";

// ----- Sexp helpers ---------------------------------------------------------

const lower = (s: string): string => s.toLowerCase();

function sexpInvalid(where: string, sexp: Sexp): never {
  throw new Error(`Invalid sexp for ${where}: ${printSexp(sexp)}`);
}

function assertList(
  sexp: Sexp,
  where: string,
): asserts sexp is { readonly kind: "list"; readonly elements: readonly Sexp[] } {
  if (sexp.kind !== "list") sexpInvalid(where, sexp);
}

function assertAtom(sexp: Sexp, where: string): asserts sexp is { readonly kind: "atom"; readonly value: string } {
  if (sexp.kind !== "atom") sexpInvalid(where, sexp);
}

const intOfSexp = (sexp: Sexp): number => {
  assertAtom(sexp, "int");
  const n = Number(sexp.value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`Invalid int: ${sexp.value}`);
  }
  return n;
};

const boolOfSexp = (sexp: Sexp): boolean => {
  assertAtom(sexp, "bool");
  const v = lower(sexp.value);
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(`Invalid bool: ${sexp.value}`);
};

const stringOfSexp = (sexp: Sexp): string => {
  assertAtom(sexp, "string");
  return sexp.value;
};

const sexpOfBool = (b: boolean): Sexp => atom(b ? "true" : "false");
const sexpOfInt = (n: number): Sexp => atom(String(n));
const sexpOfString = (s: string): Sexp => atom(s);

const listOfSexp =
  <T>(f: (s: Sexp) => T) =>
  (sexp: Sexp): T[] => {
    assertList(sexp, "list");
    return sexp.elements.map(f);
  };

const sexpOfList =
  <T>(f: (t: T) => Sexp) =>
  (ts: readonly T[]): Sexp =>
    list(ts.map(f));

// ----- Color sexp -----------------------------------------------------------

const sgr8Names: Record<string, Color.Sgr8.T> = {
  black: "Black",
  red: "Red",
  green: "Green",
  yellow: "Yellow",
  blue: "Blue",
  magenta: "Magenta",
  cyan: "Cyan",
  white: "White",
};

const sgr8OfSexp = (sexp: Sexp): Color.Sgr8.T => {
  assertAtom(sexp, "Sgr8");
  const v = lower(sexp.value);
  const found = sgr8Names[v];
  if (found === undefined) throw new Error(`Invalid Sgr8 color: ${sexp.value}`);
  return found;
};

const sexpOfSgr8 = (c: Color.Sgr8.T): Sexp => atom(c);

const rgb6OfSexp = (sexp: Sexp): Color.Rgb6.T => {
  assertList(sexp, "Rgb6");
  if (sexp.elements.length !== 3) sexpInvalid("Rgb6", sexp);
  const [r, g, b] = sexp.elements.map(intOfSexp);
  return Color.Rgb6.ofRgbExn([r!, g!, b!]);
};

const sexpOfRgb6 = (t: Color.Rgb6.T): Sexp => list([sexpOfInt(t.r), sexpOfInt(t.g), sexpOfInt(t.b)]);

const gray24OfSexp = (sexp: Sexp): Color.Gray24.T => {
  assertList(sexp, "Gray24");
  if (sexp.elements.length !== 1) sexpInvalid("Gray24", sexp);
  return Color.Gray24.ofLevelExn(intOfSexp(sexp.elements[0]!));
};

const sexpOfGray24 = (t: Color.Gray24.T): Sexp => list([sexpOfInt(t.level)]);

const rgb256OfSexp = (sexp: Sexp): Color.Rgb256.T => {
  assertList(sexp, "Rgb256");
  if (sexp.elements.length !== 3) sexpInvalid("Rgb256", sexp);
  const [r, g, b] = sexp.elements.map(intOfSexp);
  return Color.Rgb256.ofRgbExn([r!, g!, b!]);
};

const sexpOfRgb256 = (t: Color.Rgb256.T): Sexp => list([sexpOfInt(t.r), sexpOfInt(t.g), sexpOfInt(t.b)]);

/** Parses a Color.t sexp, supporting both the structured form
 *  `(Standard Red)`, `(Bright Blue)`, `(Rgb6 (r g b))`, etc., and the
 *  legacy short atom form (`red`, `blue`, `gray`, `bright_red`, ...). */
export const colorOfSexp = (sexp: Sexp): Color.T => {
  if (sexp.kind === "atom") {
    const v = lower(sexp.value);
    if (v === "default") return Color.Default;
    const std = sgr8Names[v];
    if (std !== undefined) return Color.Standard(std);
    if (v === "gray") return Color.Bright("Black");
    if (v.startsWith("bright_")) {
      const rest = v.slice("bright_".length);
      const sgr = sgr8Names[rest];
      if (sgr !== undefined) return Color.Bright(sgr);
    }
    throw new Error(`Invalid Color atom: ${sexp.value}`);
  }
  if (sexp.elements.length !== 2) sexpInvalid("Color", sexp);
  const head = sexp.elements[0]!;
  assertAtom(head, "Color head");
  const tag = lower(head.value);
  const arg = sexp.elements[1]!;
  switch (tag) {
    case "standard":
      return Color.Standard(sgr8OfSexp(arg));
    case "bright":
      return Color.Bright(sgr8OfSexp(arg));
    case "rgb6":
      return Color.Rgb6Of(rgb6OfSexp(arg));
    case "gray24":
      return Color.Gray24Of(gray24OfSexp(arg));
    case "rgb256":
      return Color.Rgb256Of(rgb256OfSexp(arg));
    default:
      throw new Error(`Invalid Color constructor: ${tag}`);
  }
};

export const sexpOfColor = (c: Color.T): Sexp => {
  switch (c.kind) {
    case "Default":
      return atom("Default");
    case "Standard":
      return list([atom("Standard"), sexpOfSgr8(c.value)]);
    case "Bright":
      return list([atom("Bright"), sexpOfSgr8(c.value)]);
    case "Rgb6":
      return list([atom("Rgb6"), sexpOfRgb6(c.value)]);
    case "Gray24":
      return list([atom("Gray24"), sexpOfGray24(c.value)]);
    case "Rgb256":
      return list([atom("Rgb256"), sexpOfRgb256(c.value)]);
  }
};

// ----- Style (Attr) sexp ----------------------------------------------------

const simpleStyles: Record<string, Attr.T> = {
  reset: Attr.Reset,
  bold: Attr.Bold,
  faint: Attr.Faint,
  dim: Attr.Faint,
  normal_weight: Attr.NormalWeight,
  italic: Attr.Italic,
  emph: Attr.Italic,
  fraktur: Attr.Fraktur,
  not_emphasis: Attr.NotEmphasis,
  underline: Attr.Underline,
  double_ul: Attr.DoubleUl,
  not_underline: Attr.NotUnderline,
  blink: Attr.Blink,
  fast_blink: Attr.FastBlink,
  not_blink: Attr.NotBlink,
  framed: Attr.Framed,
  encircled: Attr.Encircled,
  not_framed: Attr.NotFramed,
  superscript: Attr.Superscript,
  subscript: Attr.Subscript,
  not_script: Attr.NotScript,
  invert: Attr.Invert,
  inverse: Attr.Invert,
  not_invert: Attr.NotInvert,
  hide: Attr.Hide,
  not_hide: Attr.NotHide,
  strike: Attr.Strike,
  not_strike: Attr.NotStrike,
  overline: Attr.Overline,
  not_overline: Attr.NotOverline,
  variable_width: Attr.VariableWidth,
  fixed_width: Attr.FixedWidth,
};

const tagName = (t: Attr.T): string => {
  switch (t.kind) {
    case "Reset":
      return "Reset";
    case "Bold":
      return "Bold";
    case "Faint":
      return "Faint";
    case "Normal_weight":
      return "Normal_weight";
    case "Italic":
      return "Italic";
    case "Fraktur":
      return "Fraktur";
    case "Not_emphasis":
      return "Not_emphasis";
    case "Underline":
      return "Underline";
    case "Double_ul":
      return "Double_ul";
    case "Not_underline":
      return "Not_underline";
    case "Blink":
      return "Blink";
    case "Fast_blink":
      return "Fast_blink";
    case "Not_blink":
      return "Not_blink";
    case "Framed":
      return "Framed";
    case "Encircled":
      return "Encircled";
    case "Not_framed":
      return "Not_framed";
    case "Superscript":
      return "Superscript";
    case "Subscript":
      return "Subscript";
    case "Not_script":
      return "Not_script";
    case "Invert":
      return "Invert";
    case "Not_invert":
      return "Not_invert";
    case "Hide":
      return "Hide";
    case "Not_hide":
      return "Not_hide";
    case "Strike":
      return "Strike";
    case "Not_strike":
      return "Not_strike";
    case "Overline":
      return "Overline";
    case "Not_overline":
      return "Not_overline";
    case "Variable_width":
      return "Variable_width";
    case "Fixed_width":
      return "Fixed_width";
    case "Fg":
      return "Fg";
    case "Bg":
      return "Bg";
    case "Ul_color":
      return "Ul_color";
    case "Font":
      return "Font";
    case "Ideogram":
      return "Ideogram";
    case "Other":
      return "Other";
  }
};

export const styleOfSexp = (sexp: Sexp): Attr.T => {
  if (sexp.kind === "atom") {
    const v = lower(sexp.value);
    const s = simpleStyles[v];
    if (s !== undefined) return s;
    throw new Error(`Invalid style atom: ${sexp.value}`);
  }
  if (sexp.elements.length < 1) sexpInvalid("Style", sexp);
  const head = sexp.elements[0]!;
  assertAtom(head, "Style head");
  const tag = lower(head.value);
  if (sexp.elements.length === 2) {
    const arg = sexp.elements[1]!;
    switch (tag) {
      case "fg":
        return Attr.Fg(colorOfSexp(arg));
      case "bg":
        return Attr.Bg(colorOfSexp(arg));
      case "ul_color":
        return Attr.UlColor(colorOfSexp(arg));
      case "font":
        return Attr.Font(intOfSexp(arg));
      case "ideogram":
        return Attr.Ideogram(intOfSexp(arg));
      case "other":
        return Attr.Other(listOfSexp(intOfSexp)(arg));
    }
  }
  throw new Error(`Invalid Style sexp: ${printSexp(sexp)}`);
};

export const sexpOfStyle = (t: Attr.T): Sexp => {
  const name = tagName(t);
  switch (t.kind) {
    case "Fg":
    case "Bg":
    case "Ul_color":
      return list([atom(name), sexpOfColor(t.color)]);
    case "Font":
    case "Ideogram":
      return list([atom(name), sexpOfInt(t.value)]);
    case "Other":
      return list([atom(name), sexpOfList(sexpOfInt)(t.codes)]);
    default:
      return atom(name);
  }
};

const stylesOfSexp = listOfSexp(styleOfSexp);
const sexpOfStyles = sexpOfList(sexpOfStyle);

// ----- On-disk types -------------------------------------------------------

export type OnDiskAffix = {
  readonly text?: string;
  readonly style?: readonly Attr.T[];
};

export type OnDiskRule = {
  readonly prefix?: OnDiskAffix;
  readonly suffix?: OnDiskAffix;
  readonly style?: readonly Attr.T[];
};

export type OnDiskLineRule = {
  readonly prefix?: OnDiskAffix;
  readonly suffix?: OnDiskAffix;
  readonly style?: readonly Attr.T[];
  readonly wordSame?: readonly Attr.T[];
};

export type OnDiskOutput =
  | { readonly kind: "ascii" }
  | { readonly kind: "html" }
  | { readonly kind: "ansi" }
  | { readonly kind: "unrefined"; readonly inner: "ansi" | "html" }
  | { readonly kind: "side_by_side"; readonly mode: "wrap" | "truncate" };

export type OnDiskV3 = {
  readonly dontProduceUnifiedLines?: boolean;
  readonly dontOverwriteWordOldWordNew?: boolean;
  readonly configPath?: string;
  readonly context?: number;
  readonly lineBigEnough?: number;
  readonly wordBigEnough?: number;
  readonly keepWhitespace?: boolean;
  readonly findMoves?: boolean;
  readonly splitLongLines?: boolean;
  readonly interleave?: boolean;
  readonly assumeText?: boolean;
  readonly quiet?: boolean;
  readonly shallow?: boolean;
  readonly doubleCheck?: boolean;
  readonly maskUniques?: boolean;
  readonly output: OnDiskOutput;
  readonly altOld?: string;
  readonly altNew?: string;
  readonly headerOld?: OnDiskRule;
  readonly headerNew?: OnDiskRule;
  readonly hunk?: OnDiskRule;
  readonly lineSame?: OnDiskLineRule;
  readonly lineOld?: OnDiskLineRule;
  readonly lineNew?: OnDiskLineRule;
  readonly lineUnified?: OnDiskLineRule;
  readonly lineFromOld?: OnDiskLineRule;
  readonly lineToNew?: OnDiskLineRule;
  readonly lineRemovedInMove?: OnDiskLineRule;
  readonly lineAddedInMove?: OnDiskLineRule;
  readonly lineUnifiedInMove?: OnDiskLineRule;
  readonly wordOld?: OnDiskRule;
  readonly wordNew?: OnDiskRule;
  readonly locationStyle: Format.LocationStyle;
  readonly warnIfNoTrailingNewlineInBoth: boolean;
  readonly widthOverride?: number;
};

export type OnDisk = OnDiskV3;

// ----- Affix / Rule / LineRule sexp ----------------------------------------

const affixOfSexp = (sexp: Sexp): OnDiskAffix => {
  assertList(sexp, "Affix");
  const out: { text?: string; style?: readonly Attr.T[] } = {};
  for (const f of sexp.elements) {
    assertList(f, "Affix field");
    if (f.elements.length !== 2) sexpInvalid("Affix field", f);
    const head = f.elements[0]!;
    assertAtom(head, "Affix field key");
    const key = lower(head.value);
    const val = f.elements[1]!;
    if (key === "text") out.text = stringOfSexp(val);
    else if (key === "style") out.style = stylesOfSexp(val);
    else throw new Error(`Unknown Affix field: ${key}`);
  }
  return out;
};

const sexpOfAffix = (t: OnDiskAffix): Sexp => {
  const fields: Sexp[] = [];
  if (t.text !== undefined) fields.push(list([atom("text"), sexpOfString(t.text)]));
  if (t.style !== undefined) fields.push(list([atom("style"), sexpOfStyles(t.style)]));
  return list(fields);
};

const ruleOfSexp = (sexp: Sexp): OnDiskRule => {
  assertList(sexp, "Rule");
  const out: { prefix?: OnDiskAffix; suffix?: OnDiskAffix; style?: readonly Attr.T[] } = {};
  for (const f of sexp.elements) {
    assertList(f, "Rule field");
    if (f.elements.length !== 2) sexpInvalid("Rule field", f);
    const head = f.elements[0]!;
    assertAtom(head, "Rule field key");
    const key = lower(head.value);
    const val = f.elements[1]!;
    if (key === "prefix") out.prefix = affixOfSexp(val);
    else if (key === "suffix") out.suffix = affixOfSexp(val);
    else if (key === "style") out.style = stylesOfSexp(val);
    else throw new Error(`Unknown Rule field: ${key}`);
  }
  return out;
};

const sexpOfRule = (t: OnDiskRule): Sexp => {
  const fields: Sexp[] = [];
  if (t.prefix !== undefined) fields.push(list([atom("prefix"), sexpOfAffix(t.prefix)]));
  if (t.suffix !== undefined) fields.push(list([atom("suffix"), sexpOfAffix(t.suffix)]));
  if (t.style !== undefined) fields.push(list([atom("style"), sexpOfStyles(t.style)]));
  return list(fields);
};

const lineRuleOfSexp = (sexp: Sexp): OnDiskLineRule => {
  assertList(sexp, "LineRule");
  const out: {
    prefix?: OnDiskAffix;
    suffix?: OnDiskAffix;
    style?: readonly Attr.T[];
    wordSame?: readonly Attr.T[];
  } = {};
  for (const f of sexp.elements) {
    assertList(f, "LineRule field");
    if (f.elements.length !== 2) sexpInvalid("LineRule field", f);
    const head = f.elements[0]!;
    assertAtom(head, "LineRule field key");
    const key = lower(head.value);
    const val = f.elements[1]!;
    if (key === "prefix") out.prefix = affixOfSexp(val);
    else if (key === "suffix") out.suffix = affixOfSexp(val);
    else if (key === "style") out.style = stylesOfSexp(val);
    else if (key === "word_same") out.wordSame = stylesOfSexp(val);
    else throw new Error(`Unknown LineRule field: ${key}`);
  }
  return out;
};

const sexpOfLineRule = (t: OnDiskLineRule): Sexp => {
  const fields: Sexp[] = [];
  if (t.prefix !== undefined) fields.push(list([atom("prefix"), sexpOfAffix(t.prefix)]));
  if (t.suffix !== undefined) fields.push(list([atom("suffix"), sexpOfAffix(t.suffix)]));
  if (t.style !== undefined) fields.push(list([atom("style"), sexpOfStyles(t.style)]));
  if (t.wordSame !== undefined) fields.push(list([atom("word_same"), sexpOfStyles(t.wordSame)]));
  return list(fields);
};

// ----- output sexp ---------------------------------------------------------

const outputOfSexp = (sexp: Sexp): OnDiskOutput => {
  if (sexp.kind === "atom") {
    const v = lower(sexp.value);
    if (v === "ansi") return { kind: "ansi" };
    if (v === "html") return { kind: "html" };
    if (v === "ascii") return { kind: "ascii" };
    throw new Error(`Invalid output: ${sexp.value}`);
  }
  if (sexp.elements.length !== 2) sexpInvalid("output", sexp);
  const head = sexp.elements[0]!;
  assertAtom(head, "output head");
  const tag = lower(head.value);
  const inner = sexp.elements[1]!;
  if (tag === "unrefined") {
    assertAtom(inner, "unrefined arg");
    const v = lower(inner.value);
    if (v === "ansi") return { kind: "unrefined", inner: "ansi" };
    if (v === "html") return { kind: "unrefined", inner: "html" };
    throw new Error(`Invalid unrefined arg: ${v}`);
  }
  if (tag === "side_by_side") {
    assertAtom(inner, "side_by_side arg");
    const v = lower(inner.value);
    if (v === "wrap") return { kind: "side_by_side", mode: "wrap" };
    if (v === "truncate") return { kind: "side_by_side", mode: "truncate" };
    throw new Error(`Invalid side_by_side arg: ${v}`);
  }
  sexpInvalid("output", sexp);
};

const sexpOfOutput = (t: OnDiskOutput): Sexp => {
  switch (t.kind) {
    case "ascii":
      return atom("ascii");
    case "html":
      return atom("html");
    case "ansi":
      return atom("ansi");
    case "unrefined":
      return list([atom("unrefined"), atom(t.inner)]);
    case "side_by_side":
      return list([atom("side_by_side"), atom(t.mode)]);
  }
};

// ----- location_style ------------------------------------------------------

const locationStyleOfSexp = (sexp: Sexp): Format.LocationStyle => {
  assertAtom(sexp, "LocationStyle");
  const v = lower(sexp.value);
  switch (v) {
    case "diff":
      return "Diff";
    case "omake":
      return "Omake";
    case "none":
      return "None";
    case "separator":
      return "Separator";
    default:
      throw new Error(`Invalid location_style: ${v}`);
  }
};

const sexpOfLocationStyle = (t: Format.LocationStyle): Sexp => atom(t);

// ----- V3 on-disk sexp parser ---------------------------------------------

const fieldsToRecord = (sexp: Sexp): ReadonlyMap<string, Sexp> => {
  assertList(sexp, "record");
  const out = new Map<string, Sexp>();
  for (const f of sexp.elements) {
    assertList(f, "record field");
    if (f.elements.length < 1) sexpInvalid("record field", f);
    const head = f.elements[0]!;
    assertAtom(head, "record field key");
    const key = lower(head.value);
    if (f.elements.length === 1) {
      // [(key)] empty payload — treat as absent
      continue;
    }
    if (f.elements.length === 2) {
      out.set(key, f.elements[1]!);
    } else {
      // multi-arg field — pack rest into a list (rare; sexp.option case)
      out.set(key, list(f.elements.slice(1)));
    }
  }
  return out;
};

const optField = <T>(rec: ReadonlyMap<string, Sexp>, key: string, f: (s: Sexp) => T): T | undefined => {
  const s = rec.get(key);
  return s === undefined ? undefined : f(s);
};

/** Parse a V3 on-disk record. Strict: unknown fields throw. */
export const onDiskV3OfSexp = (sexp: Sexp): OnDiskV3 => {
  const rec = fieldsToRecord(sexp);
  const known = new Set<string>([
    "dont_produce_unified_lines",
    "dont_overwrite_word_old_word_new",
    "config_path",
    "context",
    "line_big_enough",
    "word_big_enough",
    "keep_whitespace",
    "find_moves",
    "split_long_lines",
    "interleave",
    "assume_text",
    "quiet",
    "shallow",
    "double_check",
    "mask_uniques",
    "output",
    "alt_old",
    "alt_new",
    "header_old",
    "header_new",
    "hunk",
    "line_same",
    "line_old",
    "line_new",
    "line_unified",
    "line_from_old",
    "line_to_new",
    "line_removed_in_move",
    "line_added_in_move",
    "line_unified_in_move",
    "word_old",
    "word_new",
    "location_style",
    "warn_if_no_trailing_newline_in_both",
    "width_override",
  ]);
  for (const k of rec.keys()) {
    if (!known.has(k)) throw new Error(`Unknown V3 field: ${k}`);
  }
  return {
    ...(optField(rec, "dont_produce_unified_lines", boolOfSexp) !== undefined
      ? { dontProduceUnifiedLines: optField(rec, "dont_produce_unified_lines", boolOfSexp)! }
      : {}),
    ...(optField(rec, "dont_overwrite_word_old_word_new", boolOfSexp) !== undefined
      ? {
          dontOverwriteWordOldWordNew: optField(rec, "dont_overwrite_word_old_word_new", boolOfSexp)!,
        }
      : {}),
    ...(optField(rec, "config_path", stringOfSexp) !== undefined
      ? { configPath: optField(rec, "config_path", stringOfSexp)! }
      : {}),
    ...(optField(rec, "context", intOfSexp) !== undefined ? { context: optField(rec, "context", intOfSexp)! } : {}),
    ...(optField(rec, "line_big_enough", intOfSexp) !== undefined
      ? { lineBigEnough: optField(rec, "line_big_enough", intOfSexp)! }
      : {}),
    ...(optField(rec, "word_big_enough", intOfSexp) !== undefined
      ? { wordBigEnough: optField(rec, "word_big_enough", intOfSexp)! }
      : {}),
    ...(optField(rec, "keep_whitespace", boolOfSexp) !== undefined
      ? { keepWhitespace: optField(rec, "keep_whitespace", boolOfSexp)! }
      : {}),
    ...(optField(rec, "find_moves", boolOfSexp) !== undefined
      ? { findMoves: optField(rec, "find_moves", boolOfSexp)! }
      : {}),
    ...(optField(rec, "split_long_lines", boolOfSexp) !== undefined
      ? { splitLongLines: optField(rec, "split_long_lines", boolOfSexp)! }
      : {}),
    ...(optField(rec, "interleave", boolOfSexp) !== undefined
      ? { interleave: optField(rec, "interleave", boolOfSexp)! }
      : {}),
    ...(optField(rec, "assume_text", boolOfSexp) !== undefined
      ? { assumeText: optField(rec, "assume_text", boolOfSexp)! }
      : {}),
    ...(optField(rec, "quiet", boolOfSexp) !== undefined ? { quiet: optField(rec, "quiet", boolOfSexp)! } : {}),
    ...(optField(rec, "shallow", boolOfSexp) !== undefined ? { shallow: optField(rec, "shallow", boolOfSexp)! } : {}),
    ...(optField(rec, "double_check", boolOfSexp) !== undefined
      ? { doubleCheck: optField(rec, "double_check", boolOfSexp)! }
      : {}),
    ...(optField(rec, "mask_uniques", boolOfSexp) !== undefined
      ? { maskUniques: optField(rec, "mask_uniques", boolOfSexp)! }
      : {}),
    output: optField(rec, "output", outputOfSexp) ?? { kind: "ansi" },
    ...(optField(rec, "alt_old", stringOfSexp) !== undefined
      ? { altOld: optField(rec, "alt_old", stringOfSexp)! }
      : {}),
    ...(optField(rec, "alt_new", stringOfSexp) !== undefined
      ? { altNew: optField(rec, "alt_new", stringOfSexp)! }
      : {}),
    ...(optField(rec, "header_old", ruleOfSexp) !== undefined
      ? { headerOld: optField(rec, "header_old", ruleOfSexp)! }
      : {}),
    ...(optField(rec, "header_new", ruleOfSexp) !== undefined
      ? { headerNew: optField(rec, "header_new", ruleOfSexp)! }
      : {}),
    ...(optField(rec, "hunk", ruleOfSexp) !== undefined ? { hunk: optField(rec, "hunk", ruleOfSexp)! } : {}),
    ...(optField(rec, "line_same", lineRuleOfSexp) !== undefined
      ? { lineSame: optField(rec, "line_same", lineRuleOfSexp)! }
      : {}),
    ...(optField(rec, "line_old", lineRuleOfSexp) !== undefined
      ? { lineOld: optField(rec, "line_old", lineRuleOfSexp)! }
      : {}),
    ...(optField(rec, "line_new", lineRuleOfSexp) !== undefined
      ? { lineNew: optField(rec, "line_new", lineRuleOfSexp)! }
      : {}),
    ...(optField(rec, "line_unified", lineRuleOfSexp) !== undefined
      ? { lineUnified: optField(rec, "line_unified", lineRuleOfSexp)! }
      : {}),
    ...(optField(rec, "line_from_old", lineRuleOfSexp) !== undefined
      ? { lineFromOld: optField(rec, "line_from_old", lineRuleOfSexp)! }
      : {}),
    ...(optField(rec, "line_to_new", lineRuleOfSexp) !== undefined
      ? { lineToNew: optField(rec, "line_to_new", lineRuleOfSexp)! }
      : {}),
    ...(optField(rec, "line_removed_in_move", lineRuleOfSexp) !== undefined
      ? { lineRemovedInMove: optField(rec, "line_removed_in_move", lineRuleOfSexp)! }
      : {}),
    ...(optField(rec, "line_added_in_move", lineRuleOfSexp) !== undefined
      ? { lineAddedInMove: optField(rec, "line_added_in_move", lineRuleOfSexp)! }
      : {}),
    ...(optField(rec, "line_unified_in_move", lineRuleOfSexp) !== undefined
      ? { lineUnifiedInMove: optField(rec, "line_unified_in_move", lineRuleOfSexp)! }
      : {}),
    ...(optField(rec, "word_old", ruleOfSexp) !== undefined ? { wordOld: optField(rec, "word_old", ruleOfSexp)! } : {}),
    ...(optField(rec, "word_new", ruleOfSexp) !== undefined ? { wordNew: optField(rec, "word_new", ruleOfSexp)! } : {}),
    locationStyle: optField(rec, "location_style", locationStyleOfSexp) ?? "Diff",
    warnIfNoTrailingNewlineInBoth:
      optField(rec, "warn_if_no_trailing_newline_in_both", boolOfSexp) ?? warnIfNoTrailingNewlineInBothDefault,
    ...(optField(rec, "width_override", intOfSexp) !== undefined
      ? { widthOverride: optField(rec, "width_override", intOfSexp)! }
      : {}),
  };
};

const isUndef = <T>(x: T | undefined): x is undefined => x === undefined;

export const sexpOfOnDiskV3 = (t: OnDiskV3): Sexp => {
  const fields: Sexp[] = [];
  const push = <T>(key: string, v: T | undefined, f: (x: T) => Sexp): void => {
    if (!isUndef(v)) fields.push(list([atom(key), f(v)]));
  };
  push("dont_produce_unified_lines", t.dontProduceUnifiedLines, sexpOfBool);
  push("dont_overwrite_word_old_word_new", t.dontOverwriteWordOldWordNew, sexpOfBool);
  push("config_path", t.configPath, sexpOfString);
  push("context", t.context, sexpOfInt);
  push("line_big_enough", t.lineBigEnough, sexpOfInt);
  push("word_big_enough", t.wordBigEnough, sexpOfInt);
  push("keep_whitespace", t.keepWhitespace, sexpOfBool);
  push("find_moves", t.findMoves, sexpOfBool);
  push("split_long_lines", t.splitLongLines, sexpOfBool);
  push("interleave", t.interleave, sexpOfBool);
  push("assume_text", t.assumeText, sexpOfBool);
  push("quiet", t.quiet, sexpOfBool);
  push("shallow", t.shallow, sexpOfBool);
  push("double_check", t.doubleCheck, sexpOfBool);
  push("mask_uniques", t.maskUniques, sexpOfBool);
  fields.push(list([atom("output"), sexpOfOutput(t.output)]));
  push("alt_old", t.altOld, sexpOfString);
  push("alt_new", t.altNew, sexpOfString);
  push("header_old", t.headerOld, sexpOfRule);
  push("header_new", t.headerNew, sexpOfRule);
  push("hunk", t.hunk, sexpOfRule);
  push("line_same", t.lineSame, sexpOfLineRule);
  push("line_old", t.lineOld, sexpOfLineRule);
  push("line_new", t.lineNew, sexpOfLineRule);
  push("line_unified", t.lineUnified, sexpOfLineRule);
  push("line_from_old", t.lineFromOld, sexpOfLineRule);
  push("line_to_new", t.lineToNew, sexpOfLineRule);
  push("line_removed_in_move", t.lineRemovedInMove, sexpOfLineRule);
  push("line_added_in_move", t.lineAddedInMove, sexpOfLineRule);
  push("line_unified_in_move", t.lineUnifiedInMove, sexpOfLineRule);
  push("word_old", t.wordOld, sexpOfRule);
  push("word_new", t.wordNew, sexpOfRule);
  fields.push(list([atom("location_style"), sexpOfLocationStyle(t.locationStyle)]));
  fields.push(list([atom("warn_if_no_trailing_newline_in_both"), sexpOfBool(t.warnIfNoTrailingNewlineInBoth)]));
  push("width_override", t.widthOverride, sexpOfInt);
  return list(fields);
};

// ----- V2 / V1 / V0 fallback parsers --------------------------------------

type OnDiskV2 = Omit<
  OnDiskV3,
  | "output"
  | "findMoves"
  | "lineFromOld"
  | "lineToNew"
  | "lineRemovedInMove"
  | "lineAddedInMove"
  | "lineUnifiedInMove"
  | "widthOverride"
> & {
  readonly output:
    | { readonly kind: "ascii" }
    | { readonly kind: "html" }
    | { readonly kind: "ansi" }
    | { readonly kind: "unrefined"; readonly inner: "ansi" | "html" };
};

const outputV2OfSexp = (sexp: Sexp): OnDiskV2["output"] => {
  const o = outputOfSexp(sexp);
  if (o.kind === "side_by_side") {
    throw new Error("side_by_side output not valid in V2");
  }
  return o;
};

const onDiskV2OfSexp = (sexp: Sexp): OnDiskV2 => {
  const rec = fieldsToRecord(sexp);
  const known = new Set<string>([
    "dont_produce_unified_lines",
    "dont_overwrite_word_old_word_new",
    "config_path",
    "context",
    "line_big_enough",
    "word_big_enough",
    "keep_whitespace",
    "split_long_lines",
    "interleave",
    "assume_text",
    "quiet",
    "shallow",
    "double_check",
    "mask_uniques",
    "output",
    "alt_old",
    "alt_new",
    "header_old",
    "header_new",
    "hunk",
    "line_same",
    "line_old",
    "line_new",
    "line_unified",
    "word_old",
    "word_new",
    "location_style",
    "warn_if_no_trailing_newline_in_both",
  ]);
  for (const k of rec.keys()) {
    if (!known.has(k)) throw new Error(`Unknown V2 field: ${k}`);
  }
  // Build base, then attach `output`.
  const base: Omit<OnDiskV2, "output"> = {
    ...(optField(rec, "dont_produce_unified_lines", boolOfSexp) !== undefined
      ? { dontProduceUnifiedLines: optField(rec, "dont_produce_unified_lines", boolOfSexp)! }
      : {}),
    ...(optField(rec, "dont_overwrite_word_old_word_new", boolOfSexp) !== undefined
      ? {
          dontOverwriteWordOldWordNew: optField(rec, "dont_overwrite_word_old_word_new", boolOfSexp)!,
        }
      : {}),
    ...(optField(rec, "config_path", stringOfSexp) !== undefined
      ? { configPath: optField(rec, "config_path", stringOfSexp)! }
      : {}),
    ...(optField(rec, "context", intOfSexp) !== undefined ? { context: optField(rec, "context", intOfSexp)! } : {}),
    ...(optField(rec, "line_big_enough", intOfSexp) !== undefined
      ? { lineBigEnough: optField(rec, "line_big_enough", intOfSexp)! }
      : {}),
    ...(optField(rec, "word_big_enough", intOfSexp) !== undefined
      ? { wordBigEnough: optField(rec, "word_big_enough", intOfSexp)! }
      : {}),
    ...(optField(rec, "keep_whitespace", boolOfSexp) !== undefined
      ? { keepWhitespace: optField(rec, "keep_whitespace", boolOfSexp)! }
      : {}),
    ...(optField(rec, "split_long_lines", boolOfSexp) !== undefined
      ? { splitLongLines: optField(rec, "split_long_lines", boolOfSexp)! }
      : {}),
    ...(optField(rec, "interleave", boolOfSexp) !== undefined
      ? { interleave: optField(rec, "interleave", boolOfSexp)! }
      : {}),
    ...(optField(rec, "assume_text", boolOfSexp) !== undefined
      ? { assumeText: optField(rec, "assume_text", boolOfSexp)! }
      : {}),
    ...(optField(rec, "quiet", boolOfSexp) !== undefined ? { quiet: optField(rec, "quiet", boolOfSexp)! } : {}),
    ...(optField(rec, "shallow", boolOfSexp) !== undefined ? { shallow: optField(rec, "shallow", boolOfSexp)! } : {}),
    ...(optField(rec, "double_check", boolOfSexp) !== undefined
      ? { doubleCheck: optField(rec, "double_check", boolOfSexp)! }
      : {}),
    ...(optField(rec, "mask_uniques", boolOfSexp) !== undefined
      ? { maskUniques: optField(rec, "mask_uniques", boolOfSexp)! }
      : {}),
    ...(optField(rec, "alt_old", stringOfSexp) !== undefined
      ? { altOld: optField(rec, "alt_old", stringOfSexp)! }
      : {}),
    ...(optField(rec, "alt_new", stringOfSexp) !== undefined
      ? { altNew: optField(rec, "alt_new", stringOfSexp)! }
      : {}),
    ...(optField(rec, "header_old", ruleOfSexp) !== undefined
      ? { headerOld: optField(rec, "header_old", ruleOfSexp)! }
      : {}),
    ...(optField(rec, "header_new", ruleOfSexp) !== undefined
      ? { headerNew: optField(rec, "header_new", ruleOfSexp)! }
      : {}),
    ...(optField(rec, "hunk", ruleOfSexp) !== undefined ? { hunk: optField(rec, "hunk", ruleOfSexp)! } : {}),
    ...(optField(rec, "line_same", lineRuleOfSexp) !== undefined
      ? { lineSame: optField(rec, "line_same", lineRuleOfSexp)! }
      : {}),
    ...(optField(rec, "line_old", lineRuleOfSexp) !== undefined
      ? { lineOld: optField(rec, "line_old", lineRuleOfSexp)! }
      : {}),
    ...(optField(rec, "line_new", lineRuleOfSexp) !== undefined
      ? { lineNew: optField(rec, "line_new", lineRuleOfSexp)! }
      : {}),
    ...(optField(rec, "line_unified", lineRuleOfSexp) !== undefined
      ? { lineUnified: optField(rec, "line_unified", lineRuleOfSexp)! }
      : {}),
    ...(optField(rec, "word_old", ruleOfSexp) !== undefined ? { wordOld: optField(rec, "word_old", ruleOfSexp)! } : {}),
    ...(optField(rec, "word_new", ruleOfSexp) !== undefined ? { wordNew: optField(rec, "word_new", ruleOfSexp)! } : {}),
    locationStyle: optField(rec, "location_style", locationStyleOfSexp) ?? "Diff",
    warnIfNoTrailingNewlineInBoth:
      optField(rec, "warn_if_no_trailing_newline_in_both", boolOfSexp) ?? warnIfNoTrailingNewlineInBothDefault,
  };
  return { ...base, output: optField(rec, "output", outputV2OfSexp) ?? { kind: "ansi" } };
};

const v2ToV3 = (v2: OnDiskV2): OnDiskV3 => ({
  ...v2,
  findMoves: false,
});

type OnDiskV1 = Omit<OnDiskV2, "output"> & {
  readonly unrefined?: boolean;
  readonly html?: boolean;
};

const onDiskV1OfSexp = (sexp: Sexp): OnDiskV1 => {
  const rec = fieldsToRecord(sexp);
  const known = new Set<string>([
    "dont_produce_unified_lines",
    "dont_overwrite_word_old_word_new",
    "config_path",
    "context",
    "line_big_enough",
    "word_big_enough",
    "unrefined",
    "keep_whitespace",
    "split_long_lines",
    "interleave",
    "assume_text",
    "quiet",
    "shallow",
    "double_check",
    "mask_uniques",
    "html",
    "alt_old",
    "alt_new",
    "header_old",
    "header_new",
    "hunk",
    "line_same",
    "line_old",
    "line_new",
    "line_unified",
    "word_old",
    "word_new",
    "location_style",
    "warn_if_no_trailing_newline_in_both",
  ]);
  for (const k of rec.keys()) {
    if (!known.has(k)) throw new Error(`Unknown V1 field: ${k}`);
  }
  return {
    ...(optField(rec, "dont_produce_unified_lines", boolOfSexp) !== undefined
      ? { dontProduceUnifiedLines: optField(rec, "dont_produce_unified_lines", boolOfSexp)! }
      : {}),
    ...(optField(rec, "dont_overwrite_word_old_word_new", boolOfSexp) !== undefined
      ? {
          dontOverwriteWordOldWordNew: optField(rec, "dont_overwrite_word_old_word_new", boolOfSexp)!,
        }
      : {}),
    ...(optField(rec, "config_path", stringOfSexp) !== undefined
      ? { configPath: optField(rec, "config_path", stringOfSexp)! }
      : {}),
    ...(optField(rec, "context", intOfSexp) !== undefined ? { context: optField(rec, "context", intOfSexp)! } : {}),
    ...(optField(rec, "line_big_enough", intOfSexp) !== undefined
      ? { lineBigEnough: optField(rec, "line_big_enough", intOfSexp)! }
      : {}),
    ...(optField(rec, "word_big_enough", intOfSexp) !== undefined
      ? { wordBigEnough: optField(rec, "word_big_enough", intOfSexp)! }
      : {}),
    ...(optField(rec, "unrefined", boolOfSexp) !== undefined
      ? { unrefined: optField(rec, "unrefined", boolOfSexp)! }
      : {}),
    ...(optField(rec, "keep_whitespace", boolOfSexp) !== undefined
      ? { keepWhitespace: optField(rec, "keep_whitespace", boolOfSexp)! }
      : {}),
    ...(optField(rec, "split_long_lines", boolOfSexp) !== undefined
      ? { splitLongLines: optField(rec, "split_long_lines", boolOfSexp)! }
      : {}),
    ...(optField(rec, "interleave", boolOfSexp) !== undefined
      ? { interleave: optField(rec, "interleave", boolOfSexp)! }
      : {}),
    ...(optField(rec, "assume_text", boolOfSexp) !== undefined
      ? { assumeText: optField(rec, "assume_text", boolOfSexp)! }
      : {}),
    ...(optField(rec, "quiet", boolOfSexp) !== undefined ? { quiet: optField(rec, "quiet", boolOfSexp)! } : {}),
    ...(optField(rec, "shallow", boolOfSexp) !== undefined ? { shallow: optField(rec, "shallow", boolOfSexp)! } : {}),
    ...(optField(rec, "double_check", boolOfSexp) !== undefined
      ? { doubleCheck: optField(rec, "double_check", boolOfSexp)! }
      : {}),
    ...(optField(rec, "mask_uniques", boolOfSexp) !== undefined
      ? { maskUniques: optField(rec, "mask_uniques", boolOfSexp)! }
      : {}),
    ...(optField(rec, "html", boolOfSexp) !== undefined ? { html: optField(rec, "html", boolOfSexp)! } : {}),
    ...(optField(rec, "alt_old", stringOfSexp) !== undefined
      ? { altOld: optField(rec, "alt_old", stringOfSexp)! }
      : {}),
    ...(optField(rec, "alt_new", stringOfSexp) !== undefined
      ? { altNew: optField(rec, "alt_new", stringOfSexp)! }
      : {}),
    ...(optField(rec, "header_old", ruleOfSexp) !== undefined
      ? { headerOld: optField(rec, "header_old", ruleOfSexp)! }
      : {}),
    ...(optField(rec, "header_new", ruleOfSexp) !== undefined
      ? { headerNew: optField(rec, "header_new", ruleOfSexp)! }
      : {}),
    ...(optField(rec, "hunk", ruleOfSexp) !== undefined ? { hunk: optField(rec, "hunk", ruleOfSexp)! } : {}),
    ...(optField(rec, "line_same", lineRuleOfSexp) !== undefined
      ? { lineSame: optField(rec, "line_same", lineRuleOfSexp)! }
      : {}),
    ...(optField(rec, "line_old", lineRuleOfSexp) !== undefined
      ? { lineOld: optField(rec, "line_old", lineRuleOfSexp)! }
      : {}),
    ...(optField(rec, "line_new", lineRuleOfSexp) !== undefined
      ? { lineNew: optField(rec, "line_new", lineRuleOfSexp)! }
      : {}),
    ...(optField(rec, "line_unified", lineRuleOfSexp) !== undefined
      ? { lineUnified: optField(rec, "line_unified", lineRuleOfSexp)! }
      : {}),
    ...(optField(rec, "word_old", ruleOfSexp) !== undefined ? { wordOld: optField(rec, "word_old", ruleOfSexp)! } : {}),
    ...(optField(rec, "word_new", ruleOfSexp) !== undefined ? { wordNew: optField(rec, "word_new", ruleOfSexp)! } : {}),
    locationStyle: optField(rec, "location_style", locationStyleOfSexp) ?? "Diff",
    warnIfNoTrailingNewlineInBoth:
      optField(rec, "warn_if_no_trailing_newline_in_both", boolOfSexp) ?? warnIfNoTrailingNewlineInBothDefault,
  };
};

const v1ToV2 = (v1: OnDiskV1): OnDiskV2 => {
  const { unrefined, html, ...rest } = v1;
  const u = unrefined ?? false;
  const h = html ?? false;
  let output: OnDiskV2["output"];
  if (h && u) output = { kind: "unrefined", inner: "html" };
  else if (h) output = { kind: "html" };
  else if (u) output = { kind: "unrefined", inner: "ansi" };
  else output = { kind: "ansi" };
  return { ...rest, output };
};

// V0: legacy old format
type V0Affix = OnDiskAffix;

type OnDiskV0 = {
  readonly configPath?: string;
  readonly context?: number;
  readonly lineBigEnough?: number;
  readonly wordBigEnough?: number;
  readonly unrefined?: boolean;
  readonly keepWhitespace?: boolean;
  readonly splitLongLines?: boolean;
  readonly interleave?: boolean;
  readonly assumeText?: boolean;
  readonly shallow?: boolean;
  readonly quiet?: boolean;
  readonly doubleCheck?: boolean;
  readonly hideUniques?: boolean;
  readonly header?: {
    readonly styleOld?: readonly Attr.T[];
    readonly styleNew?: readonly Attr.T[];
    readonly prefixOld?: V0Affix;
    readonly suffixOld?: V0Affix;
    readonly prefixNew?: V0Affix;
    readonly suffixNew?: V0Affix;
  };
  readonly lineSame?: readonly Attr.T[];
  readonly lineSamePrefix?: V0Affix;
  readonly lineChanged?: {
    readonly prefixOld: V0Affix;
    readonly prefixNew: V0Affix;
  };
  readonly wordSame?: {
    readonly styleOld: readonly Attr.T[];
    readonly styleNew: readonly Attr.T[];
  };
  readonly wordChanged?: {
    readonly styleOld: readonly Attr.T[];
    readonly styleNew: readonly Attr.T[];
    readonly prefixOld?: V0Affix;
    readonly suffixOld?: V0Affix;
    readonly prefixNew?: V0Affix;
    readonly suffixNew?: V0Affix;
  };
  readonly chunk?: OnDiskRule;
  readonly locationStyle: Format.LocationStyle;
  readonly warnIfNoTrailingNewlineInBoth: boolean;
};

const forEachField = (sexp: Sexp, where: string, f: (key: string, val: Sexp) => void): void => {
  assertList(sexp, where);
  for (const field of sexp.elements) {
    assertList(field, `${where} field`);
    if (field.elements.length !== 2) continue;
    const head = field.elements[0]!;
    if (head.kind !== "atom") continue;
    f(lower(head.value), field.elements[1]!);
  }
};

const v0HeaderOfSexp = (sexp: Sexp): NonNullable<OnDiskV0["header"]> => {
  const out: {
    styleOld?: readonly Attr.T[];
    styleNew?: readonly Attr.T[];
    prefixOld?: V0Affix;
    suffixOld?: V0Affix;
    prefixNew?: V0Affix;
    suffixNew?: V0Affix;
  } = {};
  forEachField(sexp, "V0 header", (key, val) => {
    if (key === "style_old") out.styleOld = stylesOfSexp(val);
    else if (key === "style_new") out.styleNew = stylesOfSexp(val);
    else if (key === "prefix_old") out.prefixOld = affixOfSexp(val);
    else if (key === "suffix_old") out.suffixOld = affixOfSexp(val);
    else if (key === "prefix_new") out.prefixNew = affixOfSexp(val);
    else if (key === "suffix_new") out.suffixNew = affixOfSexp(val);
  });
  return out;
};

const v0LineChangedOfSexp = (sexp: Sexp): NonNullable<OnDiskV0["lineChanged"]> => {
  let prefixOld: V0Affix = {};
  let prefixNew: V0Affix = {};
  forEachField(sexp, "V0 line_changed", (key, val) => {
    if (key === "prefix_old") prefixOld = affixOfSexp(val);
    else if (key === "prefix_new") prefixNew = affixOfSexp(val);
  });
  return { prefixOld, prefixNew };
};

const v0WordSameOfSexp = (sexp: Sexp): NonNullable<OnDiskV0["wordSame"]> => {
  let styleOld: readonly Attr.T[] = [];
  let styleNew: readonly Attr.T[] = [];
  forEachField(sexp, "V0 word_same", (key, val) => {
    if (key === "style_old") styleOld = stylesOfSexp(val);
    else if (key === "style_new") styleNew = stylesOfSexp(val);
  });
  return { styleOld, styleNew };
};

const v0WordChangedOfSexp = (sexp: Sexp): NonNullable<OnDiskV0["wordChanged"]> => {
  let styleOld: readonly Attr.T[] = [];
  let styleNew: readonly Attr.T[] = [];
  let prefixOld: V0Affix | undefined;
  let suffixOld: V0Affix | undefined;
  let prefixNew: V0Affix | undefined;
  let suffixNew: V0Affix | undefined;
  forEachField(sexp, "V0 word_changed", (key, val) => {
    if (key === "style_old") styleOld = stylesOfSexp(val);
    else if (key === "style_new") styleNew = stylesOfSexp(val);
    else if (key === "prefix_old") prefixOld = affixOfSexp(val);
    else if (key === "suffix_old") suffixOld = affixOfSexp(val);
    else if (key === "prefix_new") prefixNew = affixOfSexp(val);
    else if (key === "suffix_new") suffixNew = affixOfSexp(val);
  });
  return {
    styleOld,
    styleNew,
    ...(prefixOld !== undefined ? { prefixOld } : {}),
    ...(suffixOld !== undefined ? { suffixOld } : {}),
    ...(prefixNew !== undefined ? { prefixNew } : {}),
    ...(suffixNew !== undefined ? { suffixNew } : {}),
  };
};

const onDiskV0OfSexp = (sexp: Sexp): OnDiskV0 => {
  const rec = fieldsToRecord(sexp);
  const known = new Set<string>([
    "config_path",
    "context",
    "line_big_enough",
    "word_big_enough",
    "unrefined",
    "keep_whitespace",
    "split_long_lines",
    "interleave",
    "assume_text",
    "shallow",
    "quiet",
    "double_check",
    "hide_uniques",
    "header",
    "line_same",
    "line_same_prefix",
    "line_changed",
    "word_same",
    "word_changed",
    "chunk",
    "location_style",
    "warn_if_no_trailing_newline_in_both",
  ]);
  for (const k of rec.keys()) {
    if (!known.has(k)) throw new Error(`Unknown V0 field: ${k}`);
  }
  return {
    ...(optField(rec, "config_path", stringOfSexp) !== undefined
      ? { configPath: optField(rec, "config_path", stringOfSexp)! }
      : {}),
    ...(optField(rec, "context", intOfSexp) !== undefined ? { context: optField(rec, "context", intOfSexp)! } : {}),
    ...(optField(rec, "line_big_enough", intOfSexp) !== undefined
      ? { lineBigEnough: optField(rec, "line_big_enough", intOfSexp)! }
      : {}),
    ...(optField(rec, "word_big_enough", intOfSexp) !== undefined
      ? { wordBigEnough: optField(rec, "word_big_enough", intOfSexp)! }
      : {}),
    ...(optField(rec, "unrefined", boolOfSexp) !== undefined
      ? { unrefined: optField(rec, "unrefined", boolOfSexp)! }
      : {}),
    ...(optField(rec, "keep_whitespace", boolOfSexp) !== undefined
      ? { keepWhitespace: optField(rec, "keep_whitespace", boolOfSexp)! }
      : {}),
    ...(optField(rec, "split_long_lines", boolOfSexp) !== undefined
      ? { splitLongLines: optField(rec, "split_long_lines", boolOfSexp)! }
      : {}),
    ...(optField(rec, "interleave", boolOfSexp) !== undefined
      ? { interleave: optField(rec, "interleave", boolOfSexp)! }
      : {}),
    ...(optField(rec, "assume_text", boolOfSexp) !== undefined
      ? { assumeText: optField(rec, "assume_text", boolOfSexp)! }
      : {}),
    ...(optField(rec, "shallow", boolOfSexp) !== undefined ? { shallow: optField(rec, "shallow", boolOfSexp)! } : {}),
    ...(optField(rec, "quiet", boolOfSexp) !== undefined ? { quiet: optField(rec, "quiet", boolOfSexp)! } : {}),
    ...(optField(rec, "double_check", boolOfSexp) !== undefined
      ? { doubleCheck: optField(rec, "double_check", boolOfSexp)! }
      : {}),
    ...(optField(rec, "hide_uniques", boolOfSexp) !== undefined
      ? { hideUniques: optField(rec, "hide_uniques", boolOfSexp)! }
      : {}),
    ...(optField(rec, "header", v0HeaderOfSexp) !== undefined
      ? { header: optField(rec, "header", v0HeaderOfSexp)! }
      : {}),
    ...(optField(rec, "line_same", stylesOfSexp) !== undefined
      ? { lineSame: optField(rec, "line_same", stylesOfSexp)! }
      : {}),
    ...(optField(rec, "line_same_prefix", affixOfSexp) !== undefined
      ? { lineSamePrefix: optField(rec, "line_same_prefix", affixOfSexp)! }
      : {}),
    ...(optField(rec, "line_changed", v0LineChangedOfSexp) !== undefined
      ? { lineChanged: optField(rec, "line_changed", v0LineChangedOfSexp)! }
      : {}),
    ...(optField(rec, "word_same", v0WordSameOfSexp) !== undefined
      ? { wordSame: optField(rec, "word_same", v0WordSameOfSexp)! }
      : {}),
    ...(optField(rec, "word_changed", v0WordChangedOfSexp) !== undefined
      ? { wordChanged: optField(rec, "word_changed", v0WordChangedOfSexp)! }
      : {}),
    ...(optField(rec, "chunk", ruleOfSexp) !== undefined ? { chunk: optField(rec, "chunk", ruleOfSexp)! } : {}),
    locationStyle: optField(rec, "location_style", locationStyleOfSexp) ?? "Diff",
    warnIfNoTrailingNewlineInBoth:
      optField(rec, "warn_if_no_trailing_newline_in_both", boolOfSexp) ?? warnIfNoTrailingNewlineInBothDefault,
  };
};

const v0ToV1 = (v0: OnDiskV0): OnDiskV1 => {
  const lineSameRule: OnDiskLineRule = {
    ...(v0.lineSame !== undefined ? { style: v0.lineSame } : {}),
    ...(v0.lineSamePrefix !== undefined ? { prefix: v0.lineSamePrefix } : {}),
    ...(v0.wordSame !== undefined ? { wordSame: v0.wordSame.styleOld } : {}),
  };
  const lineOldRule: OnDiskLineRule | undefined =
    v0.lineChanged !== undefined
      ? {
          ...(v0.wordChanged !== undefined ? { style: v0.wordChanged.styleOld } : {}),
          prefix: v0.lineChanged.prefixOld,
          ...(v0.wordSame !== undefined ? { wordSame: v0.wordSame.styleOld } : {}),
        }
      : undefined;
  const lineNewRule: OnDiskLineRule | undefined =
    v0.lineChanged !== undefined
      ? {
          ...(v0.wordChanged !== undefined ? { style: v0.wordChanged.styleNew } : {}),
          prefix: v0.lineChanged.prefixNew,
          ...(v0.wordSame !== undefined ? { wordSame: v0.wordSame.styleNew } : {}),
        }
      : undefined;
  const headerOld: OnDiskRule | undefined =
    v0.header !== undefined
      ? {
          ...(v0.header.styleOld !== undefined ? { style: v0.header.styleOld } : {}),
          ...(v0.header.prefixOld !== undefined ? { prefix: v0.header.prefixOld } : {}),
          ...(v0.header.suffixOld !== undefined ? { suffix: v0.header.suffixOld } : {}),
        }
      : undefined;
  const headerNew: OnDiskRule | undefined =
    v0.header !== undefined
      ? {
          ...(v0.header.styleNew !== undefined ? { style: v0.header.styleNew } : {}),
          ...(v0.header.prefixNew !== undefined ? { prefix: v0.header.prefixNew } : {}),
          ...(v0.header.suffixNew !== undefined ? { suffix: v0.header.suffixNew } : {}),
        }
      : undefined;
  return {
    ...(v0.configPath !== undefined ? { configPath: v0.configPath } : {}),
    ...(v0.context !== undefined ? { context: v0.context } : {}),
    ...(v0.lineBigEnough !== undefined ? { lineBigEnough: v0.lineBigEnough } : {}),
    ...(v0.wordBigEnough !== undefined ? { wordBigEnough: v0.wordBigEnough } : {}),
    ...(v0.unrefined !== undefined ? { unrefined: v0.unrefined } : {}),
    ...(v0.keepWhitespace !== undefined ? { keepWhitespace: v0.keepWhitespace } : {}),
    ...(v0.interleave !== undefined ? { interleave: v0.interleave } : {}),
    ...(v0.assumeText !== undefined ? { assumeText: v0.assumeText } : {}),
    ...(v0.splitLongLines !== undefined ? { splitLongLines: v0.splitLongLines } : {}),
    ...(v0.quiet !== undefined ? { quiet: v0.quiet } : {}),
    ...(v0.shallow !== undefined ? { shallow: v0.shallow } : {}),
    ...(v0.doubleCheck !== undefined ? { doubleCheck: v0.doubleCheck } : {}),
    ...(v0.hideUniques !== undefined ? { maskUniques: v0.hideUniques } : {}),
    ...(headerOld !== undefined ? { headerOld } : {}),
    ...(headerNew !== undefined ? { headerNew } : {}),
    ...(v0.chunk !== undefined ? { hunk: v0.chunk } : {}),
    lineSame: lineSameRule,
    ...(lineOldRule !== undefined ? { lineOld: lineOldRule } : {}),
    ...(lineNewRule !== undefined ? { lineNew: lineNewRule } : {}),
    locationStyle: v0.locationStyle,
    warnIfNoTrailingNewlineInBoth: v0.warnIfNoTrailingNewlineInBoth,
  };
};

/** Multi-version on-disk sexp parser, attempting V3 → V2 → V1 → V0. */
export const onDiskOfSexp = (sexp: Sexp): OnDiskV3 => {
  const errors: string[] = [];
  try {
    return onDiskV3OfSexp(sexp);
  } catch (e) {
    errors.push(`V3: ${(e as Error).message}`);
  }
  try {
    return v2ToV3(onDiskV2OfSexp(sexp));
  } catch (e) {
    errors.push(`V2: ${(e as Error).message}`);
  }
  try {
    return v2ToV3(v1ToV2(onDiskV1OfSexp(sexp)));
  } catch (e) {
    errors.push(`V1: ${(e as Error).message}`);
  }
  try {
    return v2ToV3(v1ToV2(v0ToV1(onDiskV0OfSexp(sexp))));
  } catch (e) {
    errors.push(`V0: ${(e as Error).message}`);
  }
  throw new Error(`Patdiff.Configuration.OnDisk.ofSexp: invalid config\n${errors.join("\n")}`);
};

// ----- Default rules (for parse defaults) ---------------------------------

const fgStd = (c: Color.Sgr8.T): Attr.T => Attr.Fg(Color.Standard(c));
const bgStd = (c: Color.Sgr8.T): Attr.T => Attr.Bg(Color.Standard(c));
const bgBright = (c: Color.Sgr8.T): Attr.T => Attr.Bg(Color.Bright(c));

export const lineSameDefault: OnDiskLineRule = {
  prefix: { text: " |", style: [bgBright("Black"), fgStd("Black")] },
};

export const lineOldDefault: OnDiskLineRule = {
  prefix: { text: "-|", style: [bgStd("Red"), fgStd("Black")] },
  style: [fgStd("Red")],
  wordSame: [Attr.Fg(Color.Gray24Of(Color.Gray24.ofLevelExn(12)))],
};

export const lineNewDefault: OnDiskLineRule = {
  prefix: { text: "+|", style: [bgStd("Green"), fgStd("Black")] },
  style: [fgStd("Green")],
};

export const lineUnifiedDefault: OnDiskLineRule = {
  prefix: { text: "!|", style: [bgStd("Yellow"), fgStd("Black")] },
};

export const headerOldDefault: OnDiskLineRule = {
  prefix: { text: "------ ", style: [fgStd("Red")] },
  style: [Attr.Bold],
};

export const headerNewDefault: OnDiskLineRule = {
  prefix: { text: "++++++ ", style: [fgStd("Green")] },
  style: [Attr.Bold],
};

export const lineFromOldDefault: OnDiskLineRule = {
  prefix: { text: "<|", style: [bgStd("Magenta"), fgStd("Black")] },
  style: [fgStd("Magenta")],
};

export const lineToNewDefault: OnDiskLineRule = {
  prefix: { text: ">|", style: [bgStd("Cyan"), fgStd("Black")] },
  style: [fgStd("Cyan")],
};

export const lineRemovedInMoveDefault: OnDiskLineRule = {
  prefix: { text: ">|", style: [bgStd("Red"), fgStd("Black")] },
  style: [fgStd("Red")],
};

export const lineAddedInMoveDefault: OnDiskLineRule = {
  prefix: { text: ">|", style: [bgStd("Green"), fgStd("Black")] },
  style: [fgStd("Green")],
};

export const lineUnifiedInMoveDefault: OnDiskLineRule = {
  prefix: { text: ">|", style: [bgStd("Yellow"), fgStd("Black")] },
};

// ----- defaultString -------------------------------------------------------

export const defaultString = ((): string => {
  const lineRuleToString = (lr: OnDiskLineRule): string => printSexp(sexpOfLineRule(lr));
  return `;; -*- scheme -*-
;; patdiff Configuration file

(
 (context ${defaultContext})

 (line_same ${lineRuleToString(lineSameDefault)})

 (line_old ${lineRuleToString(lineOldDefault)})

 (line_new ${lineRuleToString(lineNewDefault)})

 (line_unified ${lineRuleToString(lineUnifiedDefault)})

 (header_old ${lineRuleToString(headerOldDefault)})

 (header_new ${lineRuleToString(headerNewDefault)})

 (hunk
  ((prefix ((text "@|") (style ((Bg (Bright Black)) (Fg (Standard Black))))))
   (suffix ((text " ============================================================") (style ())))
   (style (Bold))))

 (line_from_old ${lineRuleToString(lineFromOldDefault)})

 (line_to_new ${lineRuleToString(lineToNewDefault)})

 (line_removed_in_move ${lineRuleToString(lineRemovedInMoveDefault)})

 (line_added_in_move ${lineRuleToString(lineAddedInMoveDefault)})

 (line_unified_in_move ${lineRuleToString(lineUnifiedInMoveDefault)})
)`;
})();

// ----- parse -------------------------------------------------------------

const affixLength = (a: OnDiskAffix | undefined): number =>
  a === undefined || a.text === undefined ? 0 : a.text.length;

const affixGetText = (a: OnDiskAffix | undefined): string => (a === undefined || a.text === undefined ? "" : a.text);

const padLeft = (s: string, width: number): string => {
  if (s.length >= width) return s;
  return " ".repeat(width - s.length) + s;
};

const affixToInternal = (a: OnDiskAffix | undefined, minWidth: number): Format.Affix => {
  const text = padLeft(affixGetText(a), minWidth);
  const styles = a?.style ?? [];
  return Format.Affix.create(text, styles);
};

const ruleToInternal = (r: OnDiskRule): Format.Rule => {
  const pre = affixToInternal(r.prefix, 0);
  const suf = affixToInternal(r.suffix, 0);
  const style = r.style ?? [];
  return Format.Rule.create(style, { pre, suf });
};

const hunkToInternal = (r: OnDiskRule): Format.Rule => {
  const prefix = r.prefix ?? {};
  const suffix = r.suffix ?? {};
  return ruleToInternal({
    ...r,
    prefix: { ...prefix, text: prefix.text ?? "@@ " },
    suffix: { ...suffix, text: suffix.text ?? " @@" },
  });
};

const headerToInternal = (r: OnDiskRule | undefined, defaultPrefix: string): Format.Rule => {
  const t = r ?? {};
  const prefix = t.prefix ?? {};
  return ruleToInternal({
    ...t,
    prefix: { ...prefix, text: prefix.text ?? defaultPrefix },
  });
};

/** Convert an on-disk record into a usable [Configuration]. */
export const parse = (onDisk: OnDiskV3): Configuration => {
  const lineSame = onDisk.lineSame ?? lineSameDefault;
  const linePrev = onDisk.lineOld ?? lineOldDefault;
  const lineNext = onDisk.lineNew ?? lineNewDefault;
  const lineUnifiedRule = onDisk.lineUnified ?? lineUnifiedDefault;
  const lineFromPrev = onDisk.lineFromOld ?? lineFromOldDefault;
  const lineToNext = onDisk.lineToNew ?? lineToNewDefault;
  const lineRemovedInMove = onDisk.lineRemovedInMove ?? lineRemovedInMoveDefault;
  const lineAddedInMove = onDisk.lineAddedInMove ?? lineAddedInMoveDefault;
  const lineUnifiedInMove = onDisk.lineUnifiedInMove ?? lineUnifiedInMoveDefault;

  const allLines = [
    lineSame,
    linePrev,
    lineNext,
    lineUnifiedRule,
    lineFromPrev,
    lineToNext,
    lineRemovedInMove,
    lineAddedInMove,
  ];
  const minWidth = Math.max(0, ...allLines.map((l) => affixLength(l.prefix)));

  const createLine = (l: OnDiskLineRule): Format.Rule =>
    Format.Rule.create(l.style ?? [], {
      pre: affixToInternal(l.prefix, minWidth),
    });

  const createWordSame = (l: OnDiskLineRule): Format.Rule => Format.Rule.create(l.wordSame ?? []);

  const createWord = (lineRule: OnDiskLineRule, opt: OnDiskRule | undefined): Format.Rule => {
    const dontOverwrite = onDisk.dontOverwriteWordOldWordNew ?? false;
    const r: OnDiskRule = dontOverwrite
      ? (opt ?? {})
      : { ...(lineRule.style !== undefined ? { style: lineRule.style } : {}) };
    return ruleToInternal(r);
  };

  const output: Output = (() => {
    const o = onDisk.output;
    switch (o.kind) {
      case "ascii":
        return "Ascii";
      case "html":
        return "Html";
      case "unrefined":
        return o.inner === "html" ? "Html" : "Ansi";
      case "ansi":
      case "side_by_side":
        return "Ansi";
    }
  })();

  const unrefined = (() => {
    switch (onDisk.output.kind) {
      case "ascii":
      case "unrefined":
        return true;
      default:
        return false;
    }
  })();

  const sideBySide: SideBySide | undefined = onDisk.output.kind === "side_by_side" ? onDisk.output.mode : undefined;

  const rules: Format.Rules = {
    lineSame: createLine(lineSame),
    linePrev: createLine(linePrev),
    lineNext: createLine(lineNext),
    lineUnified: createLine(lineUnifiedRule),
    wordSamePrev: createWordSame(linePrev),
    wordSameNext: createWordSame(lineNext),
    wordSameUnified: createWordSame(lineUnifiedRule),
    wordSameUnifiedInMove: Format.Rule.create(onDisk.lineToNew?.style ?? []),
    wordPrev: createWord(linePrev, onDisk.wordOld),
    wordNext: createWord(lineNext, onDisk.wordNew),
    hunk: hunkToInternal(onDisk.hunk ?? {}),
    headerPrev: headerToInternal(onDisk.headerOld, "---"),
    headerNext: headerToInternal(onDisk.headerNew, "+++"),
    movedFromPrev: createLine(lineFromPrev),
    movedToNext: createLine(lineToNext),
    removedInMove: createLine(lineRemovedInMove),
    addedInMove: createLine(lineAddedInMove),
    lineUnifiedInMove: createLine(lineUnifiedInMove),
  };

  return createExn({
    rules,
    output,
    context: onDisk.context ?? -1,
    wordBigEnough: onDisk.wordBigEnough ?? defaultWordBigEnough,
    lineBigEnough: onDisk.lineBigEnough ?? defaultLineBigEnough,
    unrefined,
    produceUnifiedLines: !(onDisk.dontProduceUnifiedLines ?? false),
    floatTolerance: undefined,
    keepWs: onDisk.keepWhitespace ?? false,
    findMoves: onDisk.findMoves ?? false,
    splitLongLines: onDisk.splitLongLines ?? false,
    interleave: onDisk.interleave ?? true,
    assumeText: onDisk.assumeText ?? false,
    shallow: onDisk.shallow ?? false,
    quiet: onDisk.quiet ?? false,
    doubleCheck: onDisk.doubleCheck ?? false,
    maskUniques: onDisk.maskUniques ?? false,
    prevAlt: onDisk.altOld,
    nextAlt: onDisk.altNew,
    locationStyle: onDisk.locationStyle,
    warnIfNoTrailingNewlineInBoth: onDisk.warnIfNoTrailingNewlineInBoth,
    sideBySide,
    widthOverride: onDisk.widthOverride,
  });
};

// ----- File-level loaders --------------------------------------------------

const loadExnInternal = (configFile: string, set: ReadonlySet<string>): Configuration => {
  if (set.has(configFile)) {
    throw new Error("Cycle detected! file redirects to itself");
  }
  const text = fs.readFileSync(configFile, "utf8");
  const sexp = parseSexp(text);
  const onDisk = onDiskOfSexp(sexp);
  if (onDisk.configPath !== undefined) {
    const nextSet = new Set(set);
    nextSet.add(configFile);
    return loadExnInternal(onDisk.configPath, nextSet);
  }
  return parse(onDisk);
};

/** Load a config file, throwing on any error. */
export const loadExn = (configFile: string): Configuration => loadExnInternal(configFile, new Set());

/** Load a config file. Prints any error to stderr and returns [undefined]. */
export const load = (configFile: string, options: { quietErrors?: boolean } = {}): Configuration | undefined => {
  try {
    return loadExn(configFile);
  } catch (e) {
    if (!options.quietErrors) {
      process.stderr.write(`Note: error loading ${JSON.stringify(configFile)}: ${(e as Error).message}\n`);
    }
    return undefined;
  }
};

/** Get the active [Configuration], honoring [filename] (or [~/.patdiff]). */
export const getConfig = (options: { filename?: string } = {}): Configuration => {
  let file: string | undefined;
  if (options.filename === "") {
    file = undefined;
  } else if (options.filename !== undefined) {
    file = options.filename;
  } else {
    const home = os.homedir();
    const candidate = path.join(home, ".patdiff");
    if (fs.existsSync(candidate)) file = candidate;
  }
  if (file === undefined) return defaultConfiguration;
  return load(file) ?? defaultConfiguration;
};

/** Write the default sexp to [filename]. */
export const saveDefault = (args: { filename: string }): void => {
  fs.writeFileSync(args.filename, defaultString);
};

// ----- dark_bg / light_bg lazy presets ------------------------------------

const darkBgSexp = `
((context 8)
 (line_same ())
 (line_changed
  ((prefix_old ((text "-|") (style (Bold (Fg (Standard Red))))))
   (prefix_new ((text "+|") (style (Bold (Fg (Standard Green))))))))
 (word_same ((style_old ())
             (style_new ())))
 (word_changed ((style_old (Bold Underline (Fg (Standard Red))))
                (style_new ((Fg (Standard Green))))))
 (chunk
  ((prefix ((text "@@@@@@@@@@ ") (style (Bold (Fg blue)))))
   (suffix ((text " @@@@@@@@@@") (style (Bold (Fg blue)))))
   (style (Bold (Fg blue)))))
 )`;

const lightBgSexp = `
((context 8)
 (line_same (Faint))
 (line_changed ((prefix_old ((text "-|") (style (bold (Fg (Standard Red))))))
                (prefix_new ((text "+|") (style (bold (Fg (Standard Green))))))))
 (word_same ((style_old ((bg white)))
             (style_new ((Bg (Standard Yellow))))))
 (word_changed ((style_old ((bg white) bold))
                (style_new ((Bg (Standard Yellow)) bold))))
 )`;

let darkBgCache: Configuration | undefined;
let lightBgCache: Configuration | undefined;

export const darkBg = (): Configuration => {
  if (darkBgCache === undefined) {
    const v0 = onDiskV0OfSexp(parseSexp(darkBgSexp));
    darkBgCache = parse(v2ToV3(v1ToV2(v0ToV1(v0))));
  }
  return darkBgCache;
};

export const lightBg = (): Configuration => {
  if (lightBgCache === undefined) {
    const v0 = onDiskV0OfSexp(parseSexp(lightBgSexp));
    lightBgCache = parse(v2ToV3(v1ToV2(v0ToV1(v0))));
  }
  return lightBgCache;
};

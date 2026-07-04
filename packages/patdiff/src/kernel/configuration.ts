import * as Attr from "../ansi-text/attr.js";
import * as Color from "../ansi-text/color.js";
import type { Percent } from "../shared/percent.js";
import * as Format from "./format.js";
import { impliesUnrefined, type Output } from "./output.js";

export const defaultContext = 16;
export const defaultLineBigEnough = 3;
export const defaultWordBigEnough = 7;
export const tooShortToSplit = 2;
export const warnIfNoTrailingNewlineInBothDefault = true;

export type SideBySide = "wrap" | "truncate";

export type Configuration = {
  readonly output: Output;
  readonly rules: Format.Rules;
  readonly floatTolerance: Percent | undefined;
  readonly produceUnifiedLines: boolean;
  readonly unrefined: boolean;
  readonly keepWs: boolean;
  readonly findMoves: boolean;
  readonly splitLongLines: boolean;
  readonly interleave: boolean;
  readonly assumeText: boolean;
  readonly context: number;
  readonly lineBigEnough: number;
  readonly wordBigEnough: number;
  readonly shallow: boolean;
  readonly quiet: boolean;
  readonly doubleCheck: boolean;
  readonly maskUniques: boolean;
  readonly prevAlt: string | undefined;
  readonly nextAlt: string | undefined;
  readonly locationStyle: Format.LocationStyle;
  readonly warnIfNoTrailingNewlineInBoth: boolean;
  readonly sideBySide: SideBySide | undefined;
  readonly widthOverride: number | undefined;
};

export const invariant = (t: Configuration): void => {
  if (impliesUnrefined(t.output) && !t.unrefined) {
    throw new Error("output implies unrefined");
  }
  if (!(t.lineBigEnough > 0)) {
    throw new Error("line_big_enough must be positive");
  }
  if (!(t.wordBigEnough > 0)) {
    throw new Error("word_big_enough must be positive");
  }
};

export const createExn = (fields: {
  output: Output;
  rules: Format.Rules;
  floatTolerance: Percent | undefined;
  produceUnifiedLines: boolean;
  unrefined: boolean;
  keepWs: boolean;
  findMoves: boolean;
  splitLongLines: boolean;
  interleave: boolean;
  assumeText: boolean;
  context: number;
  lineBigEnough: number;
  wordBigEnough: number;
  shallow: boolean;
  quiet: boolean;
  doubleCheck: boolean;
  maskUniques: boolean;
  prevAlt: string | undefined;
  nextAlt: string | undefined;
  locationStyle: Format.LocationStyle;
  warnIfNoTrailingNewlineInBoth: boolean;
  sideBySide: SideBySide | undefined;
  widthOverride: number | undefined;
}): Configuration => {
  const t: Configuration = { ...fields };
  invariant(t);
  return t;
};

export type Override = {
  output?: Output;
  rules?: Format.Rules;
  floatTolerance?: Percent | undefined;
  produceUnifiedLines?: boolean;
  unrefined?: boolean;
  keepWs?: boolean;
  findMoves?: boolean;
  splitLongLines?: boolean;
  interleave?: boolean;
  assumeText?: boolean;
  context?: number;
  lineBigEnough?: number;
  wordBigEnough?: number;
  shallow?: boolean;
  quiet?: boolean;
  doubleCheck?: boolean;
  maskUniques?: boolean;
  prevAlt?: string | undefined;
  nextAlt?: string | undefined;
  locationStyle?: Format.LocationStyle;
  warnIfNoTrailingNewlineInBoth?: boolean;
  sideBySide?: SideBySide | undefined;
  widthOverride?: number | undefined;
};

export const override = (t: Configuration, o: Override): Configuration => {
  const output = o.output ?? t.output;
  const unrefined = (o.unrefined ?? t.unrefined) || impliesUnrefined(output);
  const merged: Configuration = {
    output,
    rules: o.rules ?? t.rules,
    floatTolerance: "floatTolerance" in o ? o.floatTolerance : t.floatTolerance,
    produceUnifiedLines: o.produceUnifiedLines ?? t.produceUnifiedLines,
    unrefined,
    keepWs: o.keepWs ?? t.keepWs,
    findMoves: o.findMoves ?? t.findMoves,
    splitLongLines: o.splitLongLines ?? t.splitLongLines,
    interleave: o.interleave ?? t.interleave,
    assumeText: o.assumeText ?? t.assumeText,
    context: o.context ?? t.context,
    lineBigEnough: o.lineBigEnough ?? t.lineBigEnough,
    wordBigEnough: o.wordBigEnough ?? t.wordBigEnough,
    shallow: o.shallow ?? t.shallow,
    quiet: o.quiet ?? t.quiet,
    doubleCheck: o.doubleCheck ?? t.doubleCheck,
    maskUniques: o.maskUniques ?? t.maskUniques,
    prevAlt: "prevAlt" in o ? o.prevAlt : t.prevAlt,
    nextAlt: "nextAlt" in o ? o.nextAlt : t.nextAlt,
    locationStyle: o.locationStyle ?? t.locationStyle,
    warnIfNoTrailingNewlineInBoth: o.warnIfNoTrailingNewlineInBoth ?? t.warnIfNoTrailingNewlineInBoth,
    sideBySide: "sideBySide" in o ? o.sideBySide : t.sideBySide,
    widthOverride: "widthOverride" in o ? o.widthOverride : t.widthOverride,
  };
  invariant(merged);
  return merged;
};

const fgStd = (c: Color.Sgr8.T): Attr.T => Attr.Fg(Color.Standard(c));
const bgStd = (c: Color.Sgr8.T): Attr.T => Attr.Bg(Color.Standard(c));
const bgBright = (c: Color.Sgr8.T): Attr.T => Attr.Bg(Color.Bright(c));

/** The CLI's default rules, mirroring OCaml [Configuration.default.rules]. Richer than
 *  [Format.Rules.defaultRules] (e.g. coloured gutters and an [@|...] hunk header). The
 *  library default ([Format.Rules.defaultRules]) intentionally remains minimal for
 *  downstream consumers that don't want gutter decoration. */
const defaultRules: Format.Rules = {
  lineSame: Format.Rule.create([], {
    pre: Format.Affix.create(" |", [bgBright("Black"), fgStd("Black")]),
  }),
  linePrev: Format.Rule.create([fgStd("Red")], {
    pre: Format.Affix.create("-|", [bgStd("Red"), fgStd("Black")]),
  }),
  lineNext: Format.Rule.create([fgStd("Green")], {
    pre: Format.Affix.create("+|", [bgStd("Green"), fgStd("Black")]),
  }),
  lineUnified: Format.Rule.create([], {
    pre: Format.Affix.create("!|", [bgStd("Yellow"), fgStd("Black")]),
  }),
  wordSamePrev: Format.Rule.create([Attr.Fg(Color.Gray24Of(Color.Gray24.ofLevelExn(12)))]),
  wordSameNext: Format.Rule.blank,
  wordSameUnified: Format.Rule.blank,
  wordSameUnifiedInMove: Format.Rule.create([fgStd("Cyan")]),
  wordPrev: Format.Rule.create([fgStd("Red")]),
  wordNext: Format.Rule.create([fgStd("Green")]),
  hunk: Format.Rule.create([Attr.Bold], {
    pre: Format.Affix.create("@|", [bgBright("Black"), fgStd("Black")]),
    suf: Format.Affix.create(" ============================================================"),
  }),
  headerPrev: Format.Rule.create([Attr.Bold], {
    pre: Format.Affix.create("------ ", [fgStd("Red")]),
  }),
  headerNext: Format.Rule.create([Attr.Bold], {
    pre: Format.Affix.create("++++++ ", [fgStd("Green")]),
  }),
  movedFromPrev: Format.Rule.create([fgStd("Magenta")], {
    pre: Format.Affix.create("<|", [bgStd("Magenta"), fgStd("Black")]),
  }),
  movedToNext: Format.Rule.create([fgStd("Cyan")], {
    pre: Format.Affix.create(">|", [bgStd("Cyan"), fgStd("Black")]),
  }),
  removedInMove: Format.Rule.create([fgStd("Red")], {
    pre: Format.Affix.create(">|", [bgStd("Red"), fgStd("Black")]),
  }),
  addedInMove: Format.Rule.create([fgStd("Green")], {
    pre: Format.Affix.create(">|", [bgStd("Green"), fgStd("Black")]),
  }),
  lineUnifiedInMove: Format.Rule.create([], {
    pre: Format.Affix.create(">|", [bgStd("Yellow"), fgStd("Black")]),
  }),
};

export const defaultConfiguration: Configuration = {
  output: "Ansi",
  rules: defaultRules,
  floatTolerance: undefined,
  produceUnifiedLines: true,
  unrefined: false,
  keepWs: false,
  findMoves: false,
  splitLongLines: false,
  interleave: true,
  assumeText: false,
  context: defaultContext,
  lineBigEnough: defaultLineBigEnough,
  wordBigEnough: defaultWordBigEnough,
  shallow: false,
  quiet: false,
  doubleCheck: false,
  maskUniques: false,
  prevAlt: undefined,
  nextAlt: undefined,
  locationStyle: "Diff",
  warnIfNoTrailingNewlineInBoth: warnIfNoTrailingNewlineInBothDefault,
  sideBySide: undefined,
  widthOverride: undefined,
};

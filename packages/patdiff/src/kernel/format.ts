import * as Attr from "../ansi-text/attr.js";
import * as Color from "../ansi-text/color.js";
import type { Hunk } from "../patience-diff/hunk.js";

export { Attr, Color };

export type Style = Attr.T;

export namespace Affix {
  export type T = {
    readonly text: string;
    readonly styles: readonly Style[];
  };

  export const create = (text: string, styles: readonly Style[] = []): T => ({ text, styles });

  export const blank: T = create("");

  export const stripStyles = (t: T): T => ({ text: t.text, styles: [] });
}

export type Affix = Affix.T;

export namespace Rule {
  export type T = {
    readonly pre: Affix;
    readonly suf: Affix;
    readonly styles: readonly Style[];
  };

  export const create = (styles: readonly Style[], opts: { pre?: Affix; suf?: Affix } = {}): T => ({
    pre: opts.pre ?? Affix.blank,
    suf: opts.suf ?? Affix.blank,
    styles,
  });

  export const blank: T = create([]);

  export const unstyledPrefix = (text: string): T => ({
    ...blank,
    pre: Affix.create(text),
  });

  export const stripStyles = (t: T): T => ({
    pre: Affix.stripStyles(t.pre),
    suf: Affix.stripStyles(t.suf),
    styles: [],
  });

  export const stripPrefix = (t: T): T => ({ ...t, pre: Affix.blank });

  export const usePrefixTextFrom = (t: T, thisPrefix: T): T => ({
    ...t,
    pre: { ...t.pre, text: thisPrefix.pre.text },
  });
}

export type Rule = Rule.T;

export namespace ColorPalette {
  export type T = {
    readonly added: Color.T;
    readonly removed: Color.T;
    readonly movedFromPrev: Color.T;
    readonly movedToNext: Color.T;
  };

  export const defaultPalette: T = {
    added: Color.Standard("Green"),
    removed: Color.Standard("Red"),
    movedFromPrev: Color.Standard("Magenta"),
    movedToNext: Color.Standard("Cyan"),
  };
}

export type ColorPalette = ColorPalette.T;

export namespace Rules {
  export type T = {
    readonly lineSame: Rule;
    readonly linePrev: Rule;
    readonly lineNext: Rule;
    readonly lineUnified: Rule;
    readonly wordSamePrev: Rule;
    readonly wordSameNext: Rule;
    readonly wordSameUnified: Rule;
    readonly wordSameUnifiedInMove: Rule;
    readonly wordPrev: Rule;
    readonly wordNext: Rule;
    readonly hunk: Rule;
    readonly headerPrev: Rule;
    readonly headerNext: Rule;
    readonly movedFromPrev: Rule;
    readonly movedToNext: Rule;
    readonly removedInMove: Rule;
    readonly addedInMove: Rule;
    readonly lineUnifiedInMove: Rule;
  };

  const innerLineChange = (text: string, color: Color.T): Rule => {
    const styles: readonly Style[] = [Attr.Fg(color)];
    const pre = Affix.create(text, [Attr.Bold, Attr.Fg(color)]);
    return Rule.create(styles, { pre });
  };

  const lineUnifiedRule = (isMove: boolean): Rule => {
    const pre = Affix.create(isMove ? ">|" : "!|", [Attr.Bold, Attr.Fg(Color.Standard("Yellow"))]);
    return Rule.create([], { pre });
  };

  const wordChange = (color: Color.T): Rule => Rule.create([Attr.Fg(color)]);

  export const defaultWithColorPalette = (palette: ColorPalette): T => ({
    lineSame: Rule.unstyledPrefix("  "),
    linePrev: innerLineChange("-|", palette.removed),
    lineNext: innerLineChange("+|", palette.added),
    lineUnified: lineUnifiedRule(false),
    wordSamePrev: Rule.blank,
    wordSameNext: Rule.blank,
    wordSameUnified: Rule.blank,
    wordSameUnifiedInMove: Rule.blank,
    wordPrev: wordChange(palette.removed),
    wordNext: wordChange(palette.added),
    hunk: Rule.blank,
    headerPrev: Rule.blank,
    headerNext: Rule.blank,
    movedFromPrev: innerLineChange("<|", palette.movedFromPrev),
    movedToNext: innerLineChange(">|", palette.movedToNext),
    removedInMove: innerLineChange(">|", palette.removed),
    addedInMove: innerLineChange(">|", palette.added),
    lineUnifiedInMove: lineUnifiedRule(true),
  });

  /** Mirrors OCaml [Format.Rules.default]: a minimal, library-default palette
   *  (e.g. [line_same = unstyled_prefix "  "]). The CLI uses the richer
   *  [Configuration.default.rules], which mirrors OCaml [Configuration.default.rules]. */
  export const defaultRules: T = defaultWithColorPalette(ColorPalette.defaultPalette);

  export const stripStyles = (t: T): T => ({
    lineSame: Rule.stripStyles(t.lineSame),
    linePrev: Rule.stripStyles(t.linePrev),
    lineNext: Rule.stripStyles(t.lineNext),
    lineUnified: Rule.stripStyles(t.lineUnified),
    wordSamePrev: Rule.stripStyles(t.wordSamePrev),
    wordSameNext: Rule.stripStyles(t.wordSameNext),
    wordSameUnified: Rule.stripStyles(t.wordSameUnified),
    wordSameUnifiedInMove: Rule.stripStyles(t.wordSameUnifiedInMove),
    wordPrev: Rule.stripStyles(t.wordPrev),
    wordNext: Rule.stripStyles(t.wordNext),
    hunk: Rule.stripStyles(t.hunk),
    headerPrev: Rule.stripStyles(t.headerPrev),
    headerNext: Rule.stripStyles(t.headerNext),
    movedFromPrev: Rule.stripStyles(t.movedFromPrev),
    movedToNext: Rule.stripStyles(t.movedToNext),
    removedInMove: Rule.stripStyles(t.removedInMove),
    addedInMove: Rule.stripStyles(t.addedInMove),
    lineUnifiedInMove: Rule.stripStyles(t.lineUnifiedInMove),
  });
}

export type Rules = Rules.T;

export type LocationStyle = "Diff" | "Omake" | "None" | "Separator";

export namespace LocationStyle {
  export const all: readonly LocationStyle[] = ["Diff", "Omake", "None", "Separator"];

  export const toString = (t: LocationStyle): string => {
    switch (t) {
      case "Diff":
        return "diff";
      case "Omake":
        return "omake";
      case "None":
        return "none";
      case "Separator":
        return "separator";
    }
  };

  export const ofString = (s: string): LocationStyle => {
    switch (s) {
      case "diff":
        return "Diff";
      case "omake":
        return "Omake";
      case "none":
        return "None";
      case "separator":
        return "Separator";
      default:
        throw new Error(`invalid location style: ${s}`);
    }
  };

  export const omakeStyleErrorMessageStart = (args: { file: string; line: number }): string =>
    `File "${args.file}", line ${args.line}, characters 0-1:`;

  export const sprint = (args: {
    style: LocationStyle;
    hunk: Hunk<string>;
    prevFilename: string;
    rule: (s: string) => string;
  }): string => {
    const { style, hunk, prevFilename, rule } = args;
    switch (style) {
      case "Diff":
        return rule(`-${hunk.prevStart},${hunk.prevSize} +${hunk.nextStart},${hunk.nextSize}`);
      case "Omake": {
        let prevStart = hunk.prevStart;
        for (const r of hunk.ranges) {
          if (r.kind === "same") {
            prevStart += r.contents.length;
          } else {
            break;
          }
        }
        return omakeStyleErrorMessageStart({
          file: prevFilename,
          line: prevStart,
        });
      }
      case "None":
        return rule("");
      case "Separator":
        return rule("=== DIFF HUNK ===");
    }
  };
}

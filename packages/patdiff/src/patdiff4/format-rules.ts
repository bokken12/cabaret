/** Format rules for 4-way diffs, ported from Iron's
 *  [patdiff4/lib/format_rules.ml]. The inner rules render each 2-way diff as
 *  patdiff would; the outer rules render a ddiff — a diff of two inner diffs —
 *  marking its own added/removed lines with "++"/"--" blocks so they read
 *  distinctly from the inner "+|"/"-|" markers. */

import * as Format from "../kernel/format.js";

const { Attr, Color, Affix, Rule } = Format;

type Sgr8 = Format.Color.Sgr8.T;

const outerLineChange = (text: string, color: Sgr8): Format.Rule => {
  const pre = Affix.create(text, [Attr.Bold, Attr.Bg(Color.Standard(color)), Attr.Fg(Color.Standard("White"))]);
  return Rule.create([], { pre });
};

const wordChange = (color: Sgr8): Format.Rule => Rule.create([Attr.Fg(Color.Standard(color))]);

export const innerDefault: Format.Rules = Format.Rules.defaultRules;

export const outerDefault: Format.Rules = {
  ...innerDefault,
  linePrev: outerLineChange("--", "Magenta"),
  lineNext: outerLineChange("++", "Cyan"),
  wordPrev: wordChange("Magenta"),
  wordNext: wordChange("Cyan"),
};

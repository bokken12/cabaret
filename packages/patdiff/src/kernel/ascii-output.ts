import * as AnsiOutput from "./ansi-output.js";
import * as Format from "./format.js";
import type { PrintArgs, RuleApplyArgs, S } from "./output.js";

export const applyRule = (text: string, args: RuleApplyArgs): string =>
  AnsiOutput.applyRule(text, {
    rule: Format.Rule.stripStyles(args.rule),
    refined: false,
  });

export const print = (args: PrintArgs): void => {
  const strippedRules = Format.Rules.stripStyles(args.rules);
  AnsiOutput.print({ ...args, rules: strippedRules });
};

export const asciiOutput: S = { applyRule, print };

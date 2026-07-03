import { apply as ansiApply } from "../ansi-text/input-output.js";
import { containsOnlyWhitespace } from "../shared/string-util.js";
import * as FileName from "./file-name.js";
import * as Format from "./format.js";
import * as Hunks from "./hunks.js";
import type { PrintArgs, RuleApplyArgs, S } from "./output.js";

export const applyStyles = (styles: readonly Format.Style[], str: string): string => ansiApply(styles, str);

const applyAffixStyles = (styles: readonly Format.Style[], str: string): string =>
  styles.length === 0 ? str : applyStyles(styles, str);

export const applyRule = (text: string, args: RuleApplyArgs): string => {
  const { rule, refined } = args;
  const onlyWhitespace = text.length > 0 && containsOnlyWhitespace(text);
  let textStyle: readonly Format.Style[];
  if (rule.styles.length === 0) {
    textStyle = [];
  } else if (refined) {
    textStyle = [Format.Attr.Reset];
  } else if (onlyWhitespace) {
    textStyle = [Format.Attr.Invert, ...rule.styles];
  } else {
    textStyle = rule.styles;
  }
  return (
    applyAffixStyles(rule.pre.styles, rule.pre.text) +
    applyAffixStyles(textStyle, text) +
    applyAffixStyles(rule.suf.styles, rule.suf.text)
  );
};

const printHeader = (args: {
  rules: Format.Rules;
  fileNames: readonly [FileName.FileName, FileName.FileName];
  print: (s: string) => void;
}): void => {
  const [prevFile, nextFile] = args.fileNames;
  args.print(
    applyRule(FileName.displayName(prevFile), {
      rule: args.rules.headerPrev,
      refined: false,
    }),
  );
  args.print(
    applyRule(FileName.displayName(nextFile), {
      rule: args.rules.headerNext,
      refined: false,
    }),
  );
};

export const print = (args: PrintArgs): void => {
  const { printGlobalHeader, fileNames, rules, print: printer, locationStyle, hunks } = args;
  const [prevFile] = fileNames;
  if (printGlobalHeader) {
    printHeader({ rules, fileNames, print: printer });
  }
  Hunks.iter_({
    fHunkBreak: (hunk) => {
      const line = Format.LocationStyle.sprint({
        style: locationStyle,
        hunk,
        prevFilename: FileName.displayName(prevFile),
        rule: (s) => applyRule(s, { rule: rules.hunk, refined: false }),
      });
      printer(line);
    },
    fLine: printer,
    hunks,
  });
};

export const ansiOutput: S = { applyRule, print };

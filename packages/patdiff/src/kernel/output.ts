import type { FileName } from "./file-name.js";
import type * as Format from "./format.js";
import type { Hunks } from "./hunks.js";

export type Output = "Ansi" | "Ascii" | "Html";

export const impliesUnrefined = (t: Output): boolean => {
  switch (t) {
    case "Ansi":
    case "Html":
      return false;
    case "Ascii":
      return true;
  }
};

export type PrintArgs = {
  printGlobalHeader: boolean;
  fileNames: readonly [FileName, FileName];
  rules: Format.Rules;
  print: (s: string) => void;
  locationStyle: Format.LocationStyle;
  hunks: Hunks;
};

export type RuleApplyArgs = {
  rule: Format.Rule;
  refined: boolean;
};

export type S = {
  applyRule: (s: string, args: RuleApplyArgs) => string;
  print: (args: PrintArgs) => void;
};

import { Hunk } from "../patience-diff/hunk.js";
import type { Configuration } from "./configuration.js";
import { override as configOverride } from "./configuration.js";
import type { DiffInput } from "./diff-input.js";
import type { Hunks } from "./hunks.js";
import * as IsBinary from "./is-binary.js";
import type { StructuredHunks } from "./patdiff-core-types.js";
import * as ShouldKeepWhitespace from "./should-keep-whitespace.js";

export type { StructuredHunks, StructuredLine } from "./patdiff-core-types.js";

export type ComparisonResult =
  | { readonly kind: "BinarySame" }
  | {
      readonly kind: "BinaryDifferent";
      readonly prevIsBinary: boolean;
      readonly nextIsBinary: boolean;
    }
  | { readonly kind: "Hunks"; readonly hunks: Hunks }
  | { readonly kind: "StructuredHunks"; readonly hunks: StructuredHunks };

export type CompareAssumingText = (args: {
  config: Configuration;
  prev: DiffInput;
  next: DiffInput;
}) =>
  | { readonly kind: "Hunks"; readonly hunks: Hunks }
  | { readonly kind: "StructuredHunks"; readonly hunks: StructuredHunks };

const updateConfigInferKeepWs = (config: Configuration, prev: DiffInput, next: DiffInput): Configuration => {
  const keepWs = config.keepWs || ShouldKeepWhitespace.forDiff({ prev, next });
  return configOverride(config, { keepWs });
};

export const create = (args: {
  config: Configuration;
  prev: DiffInput;
  next: DiffInput;
  compareAssumingText: CompareAssumingText;
}): ComparisonResult => {
  const { config, prev, next, compareAssumingText } = args;
  const [prevIsBinary, nextIsBinary] = config.assumeText
    ? [false, false]
    : [IsBinary.string(prev.text), IsBinary.string(next.text)];
  if (prevIsBinary || nextIsBinary) {
    if (prev.text === next.text) return { kind: "BinarySame" };
    return { kind: "BinaryDifferent", prevIsBinary, nextIsBinary };
  }
  const result = compareAssumingText({
    config: updateConfigInferKeepWs(config, prev, next),
    prev,
    next,
  });
  return result;
};

export const hasNoDiff = (t: ComparisonResult): boolean => {
  switch (t.kind) {
    case "BinarySame":
      return true;
    case "BinaryDifferent":
      return false;
    case "Hunks":
      return t.hunks.every((h) => Hunk.allSame(h));
    case "StructuredHunks":
      return t.hunks.every((h) => Hunk.allSame(h));
  }
};

import type { Hunk } from "../patience-diff/hunk.js";
import type { Configuration } from "./configuration.js";
import type { DiffInput } from "./diff-input.js";
import type { StructuredHunks } from "./patdiff-core-types.js";

export type { StructuredHunks, StructuredLine } from "./patdiff-core-types.js";

export type DiffResult = { readonly kind: "Different"; readonly value: string } | { readonly kind: "Same" };

export type CompareLinesResult =
  | { readonly kind: "Hunks"; readonly hunks: readonly Hunk<string>[] }
  | {
      readonly kind: "StructuredHunks";
      readonly hunks: StructuredHunks;
    };

export type CompareCoreS = {
  diffStrings: (args: {
    printGlobalHeader?: boolean;
    config: Configuration;
    prev: DiffInput;
    next: DiffInput;
  }) => DiffResult;

  compareLines: (args: {
    config: Configuration;
    prev: readonly string[];
    next: readonly string[];
  }) => CompareLinesResult;
};

export type CompareCore = {
  withoutUnix: CompareCoreS;
};

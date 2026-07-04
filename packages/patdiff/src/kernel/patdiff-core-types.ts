import type { Hunk } from "../patience-diff/hunk.js";
import type { Percent } from "../shared/percent.js";
import type { OrError } from "../shared/result.js";
import type { DiffInput } from "./diff-input.js";
import type { FileName } from "./file-name.js";
import type * as Format from "./format.js";
import type { Hunks } from "./hunks.js";
import type { Output, S as OutputS } from "./output.js";

export type StructuredLine = readonly ["Next" | "Prev" | "Same", string];
export type StructuredHunks = readonly Hunk<readonly StructuredLine[]>[];

export type ExplodedToken =
  | { readonly kind: "Newline"; readonly count: number; readonly trailer: string | undefined }
  | { readonly kind: "Word"; readonly value: string };

export type WrapOrTruncate = "wrap" | "truncate" | "neither";
export type SideBySideMode = "wrap" | "truncate";

export type PatdiffCoreS = {
  diff: (args: {
    context: number;
    lineBigEnough: number;
    keepWs: boolean;
    findMoves: boolean;
    prev: readonly string[];
    next: readonly string[];
  }) => Hunks;

  findMoves: (args: { lineBigEnough: number; keepWs: boolean; hunks: Hunks }) => Hunks;

  refine: (args: {
    rules: Format.Rules;
    produceUnifiedLines: boolean;
    output: Output;
    keepWs: boolean;
    splitLongLines: boolean;
    interleave: boolean;
    wordBigEnough: number;
    hunks: Hunks;
  }) => Hunks;

  refineStructured: (args: {
    markNewlineChanges?: boolean;
    produceUnifiedLines: boolean;
    keepWs: boolean;
    splitLongLines: boolean;
    interleave: boolean;
    wordBigEnough: number;
    hunks: readonly Hunk<string>[];
  }) => StructuredHunks;

  unrefinedStructured: (hunks: readonly Hunk<string>[]) => StructuredHunks;

  explode: (args: { lines: readonly string[]; keepWs: boolean }) => readonly ExplodedToken[];

  buildUnified: (args: { rules: Format.Rules; output: Output; hunks: Hunks }) => readonly (readonly string[])[];

  buildSideBySide: (args: {
    widthOverride?: number;
    includeLineNumbers?: boolean;
    rules: Format.Rules;
    wrapOrTruncate: WrapOrTruncate;
    output: Output;
    hunks: StructuredHunks;
  }) => readonly (readonly (readonly [string, string])[])[];

  printUnified: (args: {
    fileNames: readonly [FileName, FileName];
    rules: Format.Rules;
    output: Output;
    locationStyle: Format.LocationStyle;
    hunks: Hunks;
  }) => void;

  printSideBySide: (args: {
    widthOverride?: number;
    fileNames: readonly [FileName, FileName];
    rules: Format.Rules;
    wrapOrTruncate: SideBySideMode;
    output: Output;
    hunks: StructuredHunks;
  }) => void;

  outputToString: (args: {
    printGlobalHeader?: boolean;
    fileNames: readonly [FileName, FileName];
    rules: Format.Rules;
    output: Output;
    locationStyle: Format.LocationStyle;
    hunks: Hunks;
  }) => string;

  outputToStringSideBySide: (args: {
    widthOverride?: number;
    fileNames: readonly [FileName, FileName];
    rules: Format.Rules;
    wrapOrTruncate: SideBySideMode;
    output: Output;
    hunks: StructuredHunks;
  }) => string;

  outputWidth: (args?: { widthOverride?: number }) => number;

  patdiff: (args: {
    context?: number;
    keepWs?: boolean;
    findMoves?: boolean;
    rules?: Format.Rules;
    output?: Output;
    produceUnifiedLines?: boolean;
    splitLongLines?: boolean;
    printGlobalHeader?: boolean;
    locationStyle?: Format.LocationStyle;
    interleave?: boolean;
    floatTolerance?: Percent;
    lineBigEnough?: number;
    wordBigEnough?: number;
    prev: DiffInput;
    next: DiffInput;
  }) => string;
};

export type OutputImpls = {
  implementation: (t: Output) => OutputS;
  consoleWidth: () => OrError<number>;
};

export type PatdiffCore = {
  defaultContext: number;
  defaultLineBigEnough: number;
  defaultWordBigEnough: number;
  removeWs: (s: string) => string;
  withoutUnix: PatdiffCoreS;
};

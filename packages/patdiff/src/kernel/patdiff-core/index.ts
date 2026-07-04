/** Public API for the patdiff core. Wires together the diff/refine/render pipeline
 *  and mirrors OCaml's [Patdiff_core] / [Patdiff_core.Without_unix]. */

import { type OrError, ok } from "../../shared/result.js";
import { splitLines } from "../../shared/string-util.js";
import * as AnsiOutput from "../ansi-output.js";
import * as AsciiOutput from "../ascii-output.js";
import * as Configuration from "../configuration.js";
import * as FileNameMod from "../file-name.js";
import * as FloatTolerance from "../float-tolerance.js";
import * as Format from "../format.js";
import * as HtmlOutput from "../html-output.js";
import type { Hunks } from "../hunks.js";
import type { Output, S as OutputS } from "../output.js";
import type { ExplodedToken, OutputImpls, PatdiffCoreS } from "../patdiff-core-types.js";
import * as ShouldKeepWhitespace from "../should-keep-whitespace.js";
import * as SideBySide from "../side-by-side.js";
import { diff as runDiff } from "./diff.js";
import { explode as runExplode, type WordOrNewline } from "./explode.js";
import { findMoves as runFindMoves } from "./find-moves.js";
import {
  refine as runRefine,
  refineStructured as runRefineStructured,
  unrefinedStructured as runUnrefinedStructured,
} from "./refine.js";
import { buildUnified as runBuildUnified, printUnified as runPrintUnified } from "./render.js";
import { removeWs } from "./word-split.js";

export type { WordOrNewline } from "./explode.js";
export { explode } from "./explode.js";
export { removeWs };

export const defaultContext = Configuration.defaultContext;
export const defaultLineBigEnough = Configuration.defaultLineBigEnough;
export const defaultWordBigEnough = Configuration.defaultWordBigEnough;
const defaultDoubleColumnWidth = 121;

const explodedTokenOf = (t: WordOrNewline): ExplodedToken =>
  t.kind === "newline" ? { kind: "Newline", count: t.count, trailer: t.trailer } : { kind: "Word", value: t.value };

/** Construct a [PatdiffCoreS] implementation given the output-backend factory and the
 *  console-width detector. */
export const make = (impls: OutputImpls): PatdiffCoreS => {
  const outputWidth = (args?: { widthOverride?: number }): number => {
    const widthOverride = args?.widthOverride;
    const consoleResult = impls.consoleWidth();
    if (consoleResult.kind === "ok") {
      const console = consoleResult.value;
      if (widthOverride !== undefined) {
        return widthOverride >= console ? widthOverride - 1 : widthOverride;
      }
      return console - 1;
    }
    if (widthOverride !== undefined) return widthOverride;
    return defaultDoubleColumnWidth;
  };

  const diff: PatdiffCoreS["diff"] = (args) =>
    runDiff({
      context: args.context,
      lineBigEnough: args.lineBigEnough,
      keepWs: args.keepWs,
      findMoves: args.findMoves,
      prev: args.prev,
      next: args.next,
    });

  const findMoves: PatdiffCoreS["findMoves"] = (args) =>
    runFindMoves({
      lineBigEnough: args.lineBigEnough,
      keepWs: args.keepWs,
      hunks: args.hunks,
    });

  const refine: PatdiffCoreS["refine"] = (args) =>
    runRefine({
      rules: args.rules,
      produceUnifiedLines: args.produceUnifiedLines,
      output: args.output,
      outputImpl: impls.implementation(args.output),
      keepWs: args.keepWs,
      splitLongLines: args.splitLongLines,
      interleave: args.interleave,
      wordBigEnough: args.wordBigEnough,
      hunks: args.hunks,
    });

  const refineStructured: PatdiffCoreS["refineStructured"] = (args) =>
    runRefineStructured({
      ...(args.markNewlineChanges !== undefined ? { markNewlineChanges: args.markNewlineChanges } : {}),
      produceUnifiedLines: args.produceUnifiedLines,
      keepWs: args.keepWs,
      splitLongLines: args.splitLongLines,
      interleave: args.interleave,
      wordBigEnough: args.wordBigEnough,
      hunks: args.hunks,
    });

  const unrefinedStructured: PatdiffCoreS["unrefinedStructured"] = (hunks) => runUnrefinedStructured(hunks);

  const explode: PatdiffCoreS["explode"] = (args) => runExplode(args.lines, args.keepWs).map(explodedTokenOf);

  const buildUnified: PatdiffCoreS["buildUnified"] = (args) =>
    runBuildUnified({
      rules: args.rules,
      outputImpl: impls.implementation(args.output),
      hunks: args.hunks,
    });

  const computeSideBySideWidth = (widthOverride?: number): number =>
    outputWidth(widthOverride !== undefined ? { widthOverride } : undefined);

  const buildSideBySide: PatdiffCoreS["buildSideBySide"] = (args) =>
    SideBySide.build({
      ...(args.widthOverride !== undefined ? { widthOverride: args.widthOverride } : {}),
      ...(args.includeLineNumbers !== undefined ? { includeLineNumbers: args.includeLineNumbers } : {}),
      rules: args.rules,
      wrapOrTruncate: args.wrapOrTruncate,
      output: args.output,
      outputImpl: impls.implementation(args.output),
      hunks: args.hunks,
      computeWidth: computeSideBySideWidth,
    });

  const printUnified: PatdiffCoreS["printUnified"] = (args) => {
    const lines: string[] = [];
    runPrintUnified({
      printGlobalHeader: true,
      fileNames: args.fileNames,
      rules: args.rules,
      outputImpl: impls.implementation(args.output),
      print: (s) => lines.push(s),
      locationStyle: args.locationStyle,
      hunks: args.hunks,
    });
    for (const l of lines) process.stdout.write(l + "\n");
  };

  const printSideBySide: PatdiffCoreS["printSideBySide"] = (args) => {
    SideBySide.print({
      ...(args.widthOverride !== undefined ? { widthOverride: args.widthOverride } : {}),
      fileNames: args.fileNames,
      rules: args.rules,
      wrapOrTruncate: args.wrapOrTruncate,
      output: args.output,
      outputImpl: impls.implementation(args.output),
      print: (s) => process.stdout.write(s + "\n"),
      hunks: args.hunks,
      computeWidth: computeSideBySideWidth,
    });
  };

  const outputToString: PatdiffCoreS["outputToString"] = (args) => {
    const lines: string[] = [];
    runPrintUnified({
      printGlobalHeader: args.printGlobalHeader ?? false,
      fileNames: args.fileNames,
      rules: args.rules,
      outputImpl: impls.implementation(args.output),
      print: (s) => lines.push(s),
      locationStyle: args.locationStyle,
      hunks: args.hunks,
    });
    return lines.join("\n");
  };

  const outputToStringSideBySide: PatdiffCoreS["outputToStringSideBySide"] = (args) =>
    SideBySide.outputToString({
      ...(args.widthOverride !== undefined ? { widthOverride: args.widthOverride } : {}),
      fileNames: args.fileNames,
      rules: args.rules,
      wrapOrTruncate: args.wrapOrTruncate,
      output: args.output,
      outputImpl: impls.implementation(args.output),
      hunks: args.hunks,
      computeWidth: computeSideBySideWidth,
    });

  const patdiff: PatdiffCoreS["patdiff"] = (args) => {
    const context = args.context ?? Configuration.defaultContext;
    const findMovesArg = args.findMoves ?? false;
    const rules = args.rules ?? Format.Rules.defaultRules;
    const output: Output = args.output ?? "Ansi";
    const produceUnifiedLines = args.produceUnifiedLines ?? true;
    const splitLongLines = args.splitLongLines ?? true;
    const locationStyle: Format.LocationStyle = args.locationStyle ?? "Diff";
    const interleave = args.interleave ?? true;
    const lineBigEnough = args.lineBigEnough ?? Configuration.defaultLineBigEnough;
    const wordBigEnough = args.wordBigEnough ?? Configuration.defaultWordBigEnough;
    const keepWsExplicit = args.keepWs ?? false;
    const keepWs = keepWsExplicit || ShouldKeepWhitespace.forDiff({ prev: args.prev, next: args.next });

    const prevLines = splitLines(args.prev.text);
    const nextLines = splitLines(args.next.text);
    let hunks: Hunks = runDiff({
      context,
      lineBigEnough,
      keepWs,
      findMoves: findMovesArg,
      prev: prevLines,
      next: nextLines,
    });
    hunks = runRefine({
      rules,
      produceUnifiedLines,
      output,
      outputImpl: impls.implementation(output),
      keepWs,
      splitLongLines,
      interleave,
      wordBigEnough,
      hunks,
    });
    if (args.floatTolerance !== undefined) {
      hunks = FloatTolerance.apply(hunks, args.floatTolerance, context);
    }
    const fileNames = [FileNameMod.fake(args.prev.name), FileNameMod.fake(args.next.name)] as const;
    return outputToString({
      ...(args.printGlobalHeader !== undefined ? { printGlobalHeader: args.printGlobalHeader } : {}),
      fileNames,
      rules,
      output,
      locationStyle,
      hunks,
    });
  };

  return {
    diff,
    findMoves,
    refine,
    refineStructured,
    unrefinedStructured,
    explode,
    buildUnified,
    buildSideBySide,
    printUnified,
    printSideBySide,
    outputToString,
    outputToStringSideBySide,
    outputWidth,
    patdiff,
  };
};

/** Default output implementations: maps [Output] to the corresponding [OutputS] impl. */
const defaultImplementation = (t: Output): OutputS => {
  switch (t) {
    case "Ansi":
      return AnsiOutput.ansiOutput;
    case "Ascii":
      return AsciiOutput.asciiOutput;
    case "Html":
      return HtmlOutput.withoutMtime;
  }
};

/** [Without_unix]: no console-width detection, always returns ok(defaultDoubleColumnWidth). */
export const withoutUnix: PatdiffCoreS = make({
  implementation: defaultImplementation,
  consoleWidth: (): OrError<number> => ok(defaultDoubleColumnWidth),
});

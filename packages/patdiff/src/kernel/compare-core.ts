/** High-level compare entry points for the kernel. Mirrors OCaml's [compare_core.ml].
 *  Handles binary detection, whitespace heuristics, float tolerance, then dispatches
 *  to [PatdiffCore] for refinement and rendering. */

import type { Hunk } from "../patience-diff/hunk.js";
import { Hunks as PdHunks } from "../patience-diff/hunks.js";
import { splitLines } from "../shared/string-util.js";
import type { CompareCoreS, CompareLinesResult } from "./compare-core-types.js";
import * as ComparisonResult from "./comparison-result.js";
import type { Configuration } from "./configuration.js";
import type { DiffInput } from "./diff-input.js";
import * as FileHelpers from "./file-helpers.js";
import * as FileName from "./file-name.js";
import * as FloatTolerance from "./float-tolerance.js";
import type { Hunks } from "./hunks.js";
import * as PatdiffCore from "./patdiff-core.js";
import type { PatdiffCoreS } from "./patdiff-core-types.js";

/** Build a [CompareCoreS] backed by the given [PatdiffCoreS] implementation. */
export const make = (patdiffCore: PatdiffCoreS): CompareCoreS => {
  const compareLines = (args: {
    config: Configuration;
    prev: readonly string[];
    next: readonly string[];
  }): CompareLinesResult => {
    const { config, prev, next } = args;
    let hunks: Hunks = patdiffCore.diff({
      context: config.context,
      lineBigEnough: config.lineBigEnough,
      keepWs: config.keepWs,
      findMoves: config.findMoves,
      prev,
      next,
    });
    if (config.floatTolerance !== undefined) {
      hunks = FloatTolerance.apply(hunks as Hunk<string>[], config.floatTolerance, config.context);
    }
    if (config.unrefined) {
      // Convert Replace ranges to Prev+Next so they aren't later interpreted as
      // refined.
      const unified = PdHunks.unified(hunks as Hunk<string>[]);
      if (config.sideBySide !== undefined) {
        return {
          kind: "StructuredHunks",
          hunks: patdiffCore.unrefinedStructured(unified),
        };
      }
      return { kind: "Hunks", hunks: unified };
    }
    if (config.sideBySide !== undefined) {
      return {
        kind: "StructuredHunks",
        hunks: patdiffCore.refineStructured({
          markNewlineChanges: true,
          produceUnifiedLines: false,
          keepWs: config.keepWs,
          splitLongLines: config.splitLongLines,
          interleave: config.interleave,
          wordBigEnough: config.wordBigEnough,
          hunks,
        }),
      };
    }
    return {
      kind: "Hunks",
      hunks: patdiffCore.refine({
        rules: config.rules,
        output: config.output,
        keepWs: config.keepWs,
        produceUnifiedLines: config.produceUnifiedLines,
        splitLongLines: config.splitLongLines,
        interleave: config.interleave,
        wordBigEnough: config.wordBigEnough,
        hunks,
      }),
    };
  };

  const diffStrings = (args: {
    printGlobalHeader?: boolean;
    config: Configuration;
    prev: DiffInput;
    next: DiffInput;
  }): { readonly kind: "Different"; readonly value: string } | { readonly kind: "Same" } => {
    const { config, prev, next } = args;
    const lines = (input: DiffInput): readonly string[] => splitLines(input.text);
    const result = ComparisonResult.create({
      config,
      prev,
      next,
      compareAssumingText: ({ config: cfg, prev: p, next: n }) => {
        const cl = compareLines({
          config: cfg,
          prev: lines(p),
          next: lines(n),
        });
        if (cl.kind === "Hunks") return { kind: "Hunks", hunks: cl.hunks };
        return { kind: "StructuredHunks", hunks: cl.hunks };
      },
    });
    if (ComparisonResult.hasNoDiff(result)) return { kind: "Same" };
    switch (result.kind) {
      case "BinarySame":
        throw new Error("BinarySame is no diff");
      case "BinaryDifferent": {
        const msg = FileHelpers.binaryDifferentMessage({
          config,
          prevFile: FileName.fake(prev.name),
          prevIsBinary: result.prevIsBinary,
          nextFile: FileName.fake(next.name),
          nextIsBinary: result.nextIsBinary,
        });
        return { kind: "Different", value: msg };
      }
      case "Hunks": {
        const value = patdiffCore.outputToString({
          ...(args.printGlobalHeader !== undefined ? { printGlobalHeader: args.printGlobalHeader } : {}),
          fileNames: [FileName.fake(prev.name), FileName.fake(next.name)],
          rules: config.rules,
          output: config.output,
          locationStyle: config.locationStyle,
          hunks: result.hunks,
        });
        return { kind: "Different", value };
      }
      case "StructuredHunks": {
        const value = patdiffCore.outputToStringSideBySide({
          ...(config.widthOverride !== undefined ? { widthOverride: config.widthOverride } : {}),
          fileNames: [FileName.fake(prev.name), FileName.fake(next.name)],
          rules: config.rules,
          output: config.output,
          wrapOrTruncate: config.sideBySide ?? "wrap",
          hunks: result.hunks,
        });
        return { kind: "Different", value };
      }
    }
  };

  return { compareLines, diffStrings };
};

/** [Without_unix]-equivalent: uses [PatdiffCore.withoutUnix]. */
export const withoutUnix: CompareCoreS = make(PatdiffCore.withoutUnix);

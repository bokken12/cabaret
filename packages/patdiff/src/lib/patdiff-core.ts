/** Node-flavored Patdiff_core: detects the console width via [process.stdout.columns]. */

import * as AnsiOutput from "../kernel/ansi-output.js";
import * as AsciiOutput from "../kernel/ascii-output.js";
import type { Output, S as OutputS } from "../kernel/output.js";
import { make as makeKernel } from "../kernel/patdiff-core/index.js";
import type { OutputImpls, PatdiffCoreS } from "../kernel/patdiff-core-types.js";
import { err, type OrError, ok } from "../shared/result.js";
import { withNodeMtime } from "./html-output.js";

export {
  defaultContext,
  defaultLineBigEnough,
  defaultWordBigEnough,
  explode,
  removeWs,
  type WordOrNewline,
  withoutUnix,
} from "../kernel/patdiff-core.js";

export type {
  ExplodedToken,
  OutputImpls,
  PatdiffCore,
  PatdiffCoreS,
  StructuredHunks,
  StructuredLine,
} from "../kernel/patdiff-core-types.js";

const implementation = (t: Output): OutputS => {
  switch (t) {
    case "Ansi":
      return AnsiOutput.ansiOutput;
    case "Ascii":
      return AsciiOutput.asciiOutput;
    case "Html":
      return withNodeMtime;
  }
};

const nodeConsoleWidth = (): OrError<number> => {
  const cols = process.stdout.columns;
  if (typeof cols === "number" && cols > 0) return ok(cols);
  return err(new Error("console width unavailable"));
};

const impls: OutputImpls = {
  implementation,
  consoleWidth: nodeConsoleWidth,
};

/** Node I/O instance: real console-width detection + Node-aware HTML mtime. */
export const withNodeIo: PatdiffCoreS = makeKernel(impls);

/** Re-export the kernel factory under the [make] name. */
export { makeKernel as make };

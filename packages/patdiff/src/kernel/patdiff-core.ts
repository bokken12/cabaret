/** Patdiff core: top-level diff/refine/render pipeline. See [patdiff_core_intf.ts] for
 *  the public interface and [patdiff-core/] for the implementation split. */

export {
  defaultContext,
  defaultLineBigEnough,
  defaultWordBigEnough,
  explode,
  make,
  removeWs,
  type WordOrNewline,
  withoutUnix,
} from "./patdiff-core/index.js";

export type {
  ExplodedToken,
  OutputImpls,
  PatdiffCore,
  PatdiffCoreS,
  StructuredHunks,
  StructuredLine,
} from "./patdiff-core-types.js";

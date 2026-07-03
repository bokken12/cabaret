/** Public API for the Node-flavored [Patdiff] library.
 *  Mirrors OCaml's [patdiff/lib/src/patdiff.ml]. */

export * as AnsiOutput from "../kernel/ansi-output.js";
export * as DiffInput from "../kernel/diff-input.js";
export * as FileName from "../kernel/file-name.js";
export * as Format from "../kernel/format.js";
export * as Hunks from "../kernel/hunks.js";
export * as Output from "../kernel/output.js";

export * as CompareCore from "./compare-core.js";
export * as Configuration from "./configuration.js";
export * as HtmlOutput from "./html-output.js";
export * as PatdiffCore from "./patdiff-core.js";

export * as Private from "./private.js";

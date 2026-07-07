// The kernel's public types embed AnsiText (e.g. [SideBySide.Line] contents), so
// consumers of those types need the module itself.
export * as AnsiText from "../ansi-text/ansi-text.js";
export * as AnsiOutput from "./ansi-output.js";
export * as AsciiOutput from "./ascii-output.js";
export * as CompareCore from "./compare-core.js";
// Type-only re-exports for the interface modules.
export type * as CompareCoreIntf from "./compare-core-types.js";
export * as ComparisonResult from "./comparison-result.js";
export * as Configuration from "./configuration.js";
export * as DiffInput from "./diff-input.js";
export * as FileHelpers from "./file-helpers.js";
export * as FileName from "./file-name.js";
export * as FloatTolerance from "./float-tolerance.js";
export * as Format from "./format.js";
export * as HtmlOutput from "./html-output.js";
export * as Hunks from "./hunks.js";
export * as Import from "./import.js";
export * as IsBinary from "./is-binary.js";
export * as Output from "./output.js";
export * as PatdiffCore from "./patdiff-core.js";
export type * as PatdiffCoreIntf from "./patdiff-core-types.js";
export * as ShouldKeepWhitespace from "./should-keep-whitespace.js";
export * as SideBySide from "./side-by-side.js";

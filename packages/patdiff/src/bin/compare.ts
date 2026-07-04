/** Translation of OCaml's [Patdiff_bin.Compare]. Dispatches the [compare]
 *  subcommand: parses CLI flags, loads/overrides the configuration, then
 *  invokes the library to diff two files or directories. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Output } from "../kernel/output.js";
import type { FileFilter } from "../lib/compare-core.js";
import { CompareCore, Configuration, Format } from "../lib/patdiff.js";
import * as Percent from "../shared/percent.js";

import * as MakeConfig from "./make-config.js";
import { type FlagDef, getBool, getInt, getNoArg, getString, getStringList, parseArgs } from "./parse-args.js";
import * as Readme from "./readme.js";
import * as WrapOrTruncate from "./wrap-or-truncate.js";

// ----- flag definitions ----------------------------------------------------

const flagDefs: readonly FlagDef[] = [
  // Config selection
  { name: "default", spec: { kind: "noArg" } },
  { name: "file", spec: { kind: "string" } },
  // Core knobs
  { name: "context", spec: { kind: "int" } },
  { name: "line-big-enough", spec: { kind: "int" } },
  { name: "word-big-enough", spec: { kind: "int" } },
  { name: "no-semantic-cleanup", spec: { kind: "noArg" } },
  // Toggles
  { name: "unrefined", spec: { kind: "noArg" } },
  { name: "keep-whitespace", spec: { kind: "noArg" } },
  { name: "split-long-lines", spec: { kind: "noArg" } },
  { name: "no-interleave", spec: { kind: "noArg" } },
  { name: "text", spec: { kind: "noArg" } },
  // Output mode (choose_one)
  { name: "html", spec: { kind: "noArg" } },
  { name: "ascii", spec: { kind: "noArg" } },
  { name: "ansi", spec: { kind: "noArg" } },
  { name: "dont-produce-unified-lines", spec: { kind: "noArg" } },
  { name: "quiet", spec: { kind: "noArg" } },
  { name: "shallow", spec: { kind: "noArg" } },
  { name: "double-check", spec: { kind: "noArg" } },
  { name: "mask-uniques", spec: { kind: "noArg" } },
  // [float-tolerance] takes a Percent-formatted string (e.g. "1.5%").
  { name: "float-tolerance", spec: { kind: "string" } },
  // Alt names
  { name: "alt-prev", aliases: ["alt-old"], spec: { kind: "string" } },
  { name: "alt-next", aliases: ["alt-new"], spec: { kind: "string" } },
  // Special handlers
  { name: "make-config", spec: { kind: "string" } },
  { name: "readme", spec: { kind: "noArg" } },
  { name: "version", spec: { kind: "noArg" } },
  { name: "build-info", spec: { kind: "noArg" } },
  { name: "help", aliases: ["h"], spec: { kind: "noArg" } },
  // Directory filtering
  { name: "include", spec: { kind: "stringList" } },
  { name: "exclude", spec: { kind: "stringList" } },
  { name: "reverse", spec: { kind: "noArg" } },
  // Location style
  { name: "location-style", spec: { kind: "string" } },
  // Trailing newline warning
  { name: "warn-if-no-trailing-newline-in-both", spec: { kind: "bool" } },
  // Moves
  { name: "find-moves", spec: { kind: "noArg" } },
  // Side-by-side
  { name: "side-by-side", spec: { kind: "string" } },
  { name: "width", spec: { kind: "int" } },
];

// ----- types ---------------------------------------------------------------

type CompareFlags = {
  readonly unrefinedOpt?: boolean;
  readonly produceUnifiedLinesOpt?: boolean;
  readonly floatToleranceOpt?: Percent.Percent;
  readonly keepWsOpt?: boolean;
  readonly interleaveOpt?: boolean;
  readonly assumeTextOpt?: boolean;
  readonly splitLongLinesOpt?: boolean;
  readonly shallowOpt?: boolean;
  readonly quietOpt?: boolean;
  readonly doubleCheckOpt?: boolean;
  readonly maskUniquesOpt?: boolean;
  readonly output?: Output;
  readonly contextOpt?: number;
  readonly lineBigEnoughOpt?: number;
  readonly wordBigEnoughOpt?: number;
  readonly configOpt?: string;
  readonly prevFile: string;
  readonly nextFile: string;
  /** [undefined] = no flag, ["__none__"] flag passed with explicit "no alt".
   *  We mirror OCaml's [string option option]: outer [None] = unspecified,
   *  outer [Some None] = clear, outer [Some (Some v)] = set to v.
   *  Here we just allow [string | undefined], matching CLI behavior:
   *  flag specified → string value, absent → undefined. The library
   *  treats [undefined] as "don't override". */
  readonly prevAltOpt?: string;
  readonly nextAltOpt?: string;
  readonly include: readonly RegExp[];
  readonly exclude: readonly RegExp[];
  readonly locationStyle?: Format.LocationStyle;
  readonly warnIfNoTrailingNewlineInBoth?: boolean;
  readonly findMovesOpt?: boolean;
  readonly sideBySideOpt?: WrapOrTruncate.T;
  readonly widthOverride?: number;
};

// ----- helpers -------------------------------------------------------------

const tempTxtFile = (prefix: string): string => {
  const fname = path.join(os.tmpdir(), `${prefix}${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}.txt`);
  // Pre-touch so unlinkSync below can clean it up.
  fs.writeFileSync(fname, "");
  process.on("exit", () => {
    try {
      fs.unlinkSync(fname);
    } catch {
      // ignore
    }
  });
  return fname;
};

const addPrefixes = ["+", ">"] as const;
const removePrefixes = ["-", "<"] as const;

const beginsWith = (line: string, prefixes: readonly string[]): boolean => prefixes.some((p) => line.startsWith(p));

const maybeRemove = (line: string, prefixes: readonly string[]): string => {
  const p = prefixes.find((pre) => line.startsWith(pre));
  if (p === undefined) return line;
  return " " + line.slice(p.length);
};

/** Read stdin and split it into a prev/next pair of temp files. Mirrors
 *  [files_from_anons] in [compare.ml]. */
const filesFromStdin = (): { prevFile: string; nextFile: string } => {
  const prevFile = tempTxtFile("patdiff_prev_");
  const nextFile = tempTxtFile("patdiff_next_");
  // Read all stdin synchronously.
  let stdinBuf = "";
  try {
    stdinBuf = fs.readFileSync(0, "utf8");
  } catch {
    stdinBuf = "";
  }
  const prevLines: string[] = [];
  const nextLines: string[] = [];
  // OCaml [In_channel.iter_lines] strips trailing newlines from each line.
  const lines = stdinBuf.split("\n");
  // Drop the last empty line that comes from a trailing newline.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    if (!beginsWith(line, addPrefixes)) {
      prevLines.push(maybeRemove(line, removePrefixes));
    }
    if (!beginsWith(line, removePrefixes)) {
      nextLines.push(maybeRemove(line, addPrefixes));
    }
  }
  const eol = (xs: string[]): string => (xs.length === 0 ? "" : xs.join("\n") + "\n");
  fs.writeFileSync(prevFile, eol(prevLines));
  fs.writeFileSync(nextFile, eol(nextLines));
  return { prevFile, nextFile };
};

const isExistingFile = (p: string): boolean => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};

const isDirectory = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// ----- flag → CompareFlags -------------------------------------------------

const compileRegex = (pattern: string): RegExp => {
  // OCaml uses [Re.Pcre.regexp]; we approximate with JavaScript regex.
  // PCRE features that JS doesn't support will throw at compile time —
  // that's a faithful "fail fast" mirror of [Pcre.regexp].
  return new RegExp(pattern);
};

const matchesAny = (s: string, rxs: readonly RegExp[]): boolean => rxs.some((rx) => rx.test(s));

const buildCompareFlags = (args: ReturnType<typeof parseArgs>): CompareFlags | { kind: "MakeConfig"; file: string } => {
  const makeConfig = getString(args, "make-config");
  if (makeConfig !== undefined) {
    return { kind: "MakeConfig", file: makeConfig };
  }

  // Config selection.
  const useDefault = getNoArg(args, "default");
  const file = getString(args, "file");
  let configOpt: string | undefined;
  if (file !== undefined && useDefault) {
    throw new Error("Cannot pass both [-default] and [-file]");
  } else if (useDefault) {
    configOpt = "";
  } else {
    configOpt = file;
  }

  // Big-enough / no-semantic-cleanup.
  const noSemanticCleanup = getNoArg(args, "no-semantic-cleanup");
  const lineBigEnough = getInt(args, "line-big-enough");
  const wordBigEnough = getInt(args, "word-big-enough");
  if (lineBigEnough !== undefined && noSemanticCleanup) {
    throw new Error("Cannot pass both [-line-big-enough] and [-no-semantic-cleanup]");
  }
  if (wordBigEnough !== undefined && noSemanticCleanup) {
    throw new Error("Cannot pass both [-word-big-enough] and [-no-semantic-cleanup]");
  }
  const lineBigEnoughOpt = lineBigEnough !== undefined ? lineBigEnough : noSemanticCleanup ? 1 : undefined;
  const wordBigEnoughOpt = wordBigEnough !== undefined ? wordBigEnough : noSemanticCleanup ? 1 : undefined;

  // Boolean toggles.
  const unrefinedOpt = getNoArg(args, "unrefined") ? true : undefined;
  const keepWsOpt = getNoArg(args, "keep-whitespace") ? true : undefined;
  const splitLongLinesOpt = getNoArg(args, "split-long-lines") ? true : undefined;
  // [no-interleave] is inverted: presence means [interleave = false].
  const interleaveOpt = getNoArg(args, "no-interleave") ? false : undefined;
  const assumeTextOpt = getNoArg(args, "text") ? true : undefined;
  // [dont-produce-unified-lines] inverted: presence means [produceUnifiedLines = false].
  const dontProduceUnified = getNoArg(args, "dont-produce-unified-lines");
  const produceUnifiedLinesOpt = dontProduceUnified ? false : undefined;
  const quietOpt = getNoArg(args, "quiet") ? true : undefined;
  const shallowOpt = getNoArg(args, "shallow") ? true : undefined;
  const doubleCheckOpt = getNoArg(args, "double-check") ? true : undefined;
  const maskUniquesOpt = getNoArg(args, "mask-uniques") ? true : undefined;

  // Output (choose_one).
  const html = getNoArg(args, "html");
  const ascii = getNoArg(args, "ascii");
  const ansi = getNoArg(args, "ansi");
  const outputChoices = [html, ascii, ansi].filter((b) => b).length;
  if (outputChoices > 1) {
    throw new Error("Pass at most one of [-html], [-ascii], [-ansi]");
  }
  const output: Output | undefined = html ? "Html" : ascii ? "Ascii" : ansi ? "Ansi" : undefined;

  // Float tolerance: parse the Percent string (e.g. "1.5%").
  const ftStr = getString(args, "float-tolerance");
  const floatTolerance = ftStr !== undefined ? Percent.parse(ftStr) : undefined;

  // Alt names.
  const prevAltOpt = getString(args, "alt-prev");
  const nextAltOpt = getString(args, "alt-next");

  // include/exclude.
  const include = getStringList(args, "include").map(compileRegex);
  const exclude = getStringList(args, "exclude").map(compileRegex);

  // Location style.
  const locStyle = getString(args, "location-style");
  const locationStyle: Format.LocationStyle | undefined =
    locStyle !== undefined ? Format.LocationStyle.ofString(locStyle) : undefined;

  // warn-if-no-trailing-newline-in-both.
  const warnIfNoTrailingNewlineInBoth = getBool(args, "warn-if-no-trailing-newline-in-both");

  // find-moves: disabled if [dont-produce-unified-lines] is set.
  const findMovesRaw = getNoArg(args, "find-moves") ? true : undefined;
  const findMovesOpt = dontProduceUnified ? false : findMovesRaw;

  // Side-by-side.
  const sideBySideStr = getString(args, "side-by-side");
  const sideBySideOpt = sideBySideStr !== undefined ? WrapOrTruncate.ofStringExn(sideBySideStr) : undefined;
  const widthOverride = getInt(args, "width");

  // Positional args: 0 (stdin), 1 (error), or 2 (prev, next).
  const pos = args.positional;
  let prevFile: string;
  let nextFile: string;
  if (pos.length === 0) {
    const stdinPair = filesFromStdin();
    prevFile = stdinPair.prevFile;
    nextFile = stdinPair.nextFile;
  } else if (pos.length === 2) {
    prevFile = pos[0]!;
    nextFile = pos[1]!;
  } else {
    throw new Error(`Expected 0 or 2 positional arguments (FILE1 FILE2), got ${pos.length}`);
  }
  if (getNoArg(args, "reverse")) {
    [prevFile, nextFile] = [nextFile, prevFile];
  }

  const result: CompareFlags = {
    ...(unrefinedOpt !== undefined ? { unrefinedOpt } : {}),
    ...(produceUnifiedLinesOpt !== undefined ? { produceUnifiedLinesOpt } : {}),
    ...(floatTolerance !== undefined ? { floatToleranceOpt: floatTolerance } : {}),
    ...(keepWsOpt !== undefined ? { keepWsOpt } : {}),
    ...(interleaveOpt !== undefined ? { interleaveOpt } : {}),
    ...(assumeTextOpt !== undefined ? { assumeTextOpt } : {}),
    ...(splitLongLinesOpt !== undefined ? { splitLongLinesOpt } : {}),
    ...(shallowOpt !== undefined ? { shallowOpt } : {}),
    ...(quietOpt !== undefined ? { quietOpt } : {}),
    ...(doubleCheckOpt !== undefined ? { doubleCheckOpt } : {}),
    ...(maskUniquesOpt !== undefined ? { maskUniquesOpt } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(getInt(args, "context") !== undefined ? { contextOpt: getInt(args, "context")! } : {}),
    ...(lineBigEnoughOpt !== undefined ? { lineBigEnoughOpt } : {}),
    ...(wordBigEnoughOpt !== undefined ? { wordBigEnoughOpt } : {}),
    ...(configOpt !== undefined ? { configOpt } : {}),
    prevFile,
    nextFile,
    ...(prevAltOpt !== undefined ? { prevAltOpt } : {}),
    ...(nextAltOpt !== undefined ? { nextAltOpt } : {}),
    include,
    exclude,
    ...(locationStyle !== undefined ? { locationStyle } : {}),
    ...(warnIfNoTrailingNewlineInBoth !== undefined ? { warnIfNoTrailingNewlineInBoth } : {}),
    ...(findMovesOpt !== undefined ? { findMovesOpt } : {}),
    ...(sideBySideOpt !== undefined ? { sideBySideOpt } : {}),
    ...(widthOverride !== undefined ? { widthOverride } : {}),
  };
  return result;
};

// ----- main pipeline -------------------------------------------------------

const applyOverride = (config: Configuration.Configuration, flags: CompareFlags): Configuration.Configuration => {
  return Configuration.override(config, {
    ...(flags.output !== undefined ? { output: flags.output } : {}),
    ...(flags.unrefinedOpt !== undefined ? { unrefined: flags.unrefinedOpt } : {}),
    ...(flags.produceUnifiedLinesOpt !== undefined ? { produceUnifiedLines: flags.produceUnifiedLinesOpt } : {}),
    ...(flags.floatToleranceOpt !== undefined ? { floatTolerance: flags.floatToleranceOpt } : {}),
    ...(flags.keepWsOpt !== undefined ? { keepWs: flags.keepWsOpt } : {}),
    ...(flags.findMovesOpt !== undefined ? { findMoves: flags.findMovesOpt } : {}),
    ...(flags.splitLongLinesOpt !== undefined ? { splitLongLines: flags.splitLongLinesOpt } : {}),
    ...(flags.interleaveOpt !== undefined ? { interleave: flags.interleaveOpt } : {}),
    ...(flags.assumeTextOpt !== undefined ? { assumeText: flags.assumeTextOpt } : {}),
    ...(flags.contextOpt !== undefined ? { context: flags.contextOpt } : {}),
    ...(flags.lineBigEnoughOpt !== undefined ? { lineBigEnough: flags.lineBigEnoughOpt } : {}),
    ...(flags.wordBigEnoughOpt !== undefined ? { wordBigEnough: flags.wordBigEnoughOpt } : {}),
    ...(flags.shallowOpt !== undefined ? { shallow: flags.shallowOpt } : {}),
    ...(flags.quietOpt !== undefined ? { quiet: flags.quietOpt } : {}),
    ...(flags.doubleCheckOpt !== undefined ? { doubleCheck: flags.doubleCheckOpt } : {}),
    ...(flags.maskUniquesOpt !== undefined ? { maskUniques: flags.maskUniquesOpt } : {}),
    ...(flags.prevAltOpt !== undefined ? { prevAlt: flags.prevAltOpt } : {}),
    ...(flags.nextAltOpt !== undefined ? { nextAlt: flags.nextAltOpt } : {}),
    ...(flags.locationStyle !== undefined ? { locationStyle: flags.locationStyle } : {}),
    ...(flags.warnIfNoTrailingNewlineInBoth !== undefined
      ? { warnIfNoTrailingNewlineInBoth: flags.warnIfNoTrailingNewlineInBoth }
      : {}),
    ...(flags.sideBySideOpt !== undefined ? { sideBySide: flags.sideBySideOpt } : {}),
    ...(flags.widthOverride !== undefined ? { widthOverride: flags.widthOverride } : {}),
  });
};

const runCompare = (flags: CompareFlags): "Same" | "Different" => {
  const config = applyOverride(
    Configuration.getConfig(flags.configOpt !== undefined ? { filename: flags.configOpt } : {}),
    flags,
  );
  const prevFile = flags.prevFile;
  const nextFile = flags.nextFile;
  const prevExists = isExistingFile(prevFile);
  const nextExists = isExistingFile(nextFile);
  if (!prevExists && !nextExists) {
    throw new Error(`Both files, ${prevFile} and ${nextFile}, do not exist`);
  }
  const prevIsDir = prevExists && isDirectory(prevFile);
  const nextIsDir = nextExists && isDirectory(nextFile);

  const checkNoDirOnlyFlags = (): void => {
    if (flags.include.length !== 0 || flags.exclude.length !== 0) {
      throw new Error("Can only specify -include or -exclude when diffing two dirs");
    }
  };

  if (prevIsDir !== nextIsDir) {
    // one is a dir, other is a file or missing
    const dir = prevIsDir ? prevFile : nextFile;
    const other = prevIsDir ? nextFile : prevFile;
    if (!isExistingFile(other)) {
      throw new Error(`${dir} is a directory, while ${other} does not exist`);
    }
    throw new Error(`${dir} is a directory, while ${other} is a file`);
  }
  if (prevIsDir && nextIsDir) {
    const fileFilter: FileFilter | undefined =
      flags.include.length === 0 && flags.exclude.length === 0
        ? undefined
        : ({ path: p, stats }): boolean => {
            if (!stats.isFile()) return true;
            if (matchesAny(p, flags.exclude)) return false;
            if (flags.include.length === 0) return true;
            return matchesAny(p, flags.include);
          };
    return CompareCore.diffDirs({
      config,
      prevDir: prevFile,
      nextDir: nextFile,
      ...(fileFilter !== undefined ? { fileFilter } : {}),
    });
  }
  // both files (or one missing)
  checkNoDirOnlyFlags();
  const realPrev = prevExists ? prevFile : "/dev/null";
  const realNext = nextExists ? nextFile : "/dev/null";
  return CompareCore.diffFiles({
    config,
    prevFile: realPrev,
    nextFile: realNext,
  });
};

// ----- entry point ---------------------------------------------------------

/** Main entry. Returns the process exit code. */
export const main = async (argv: readonly string[]): Promise<number> => {
  const parsed = parseArgs(argv, flagDefs);

  if (getNoArg(parsed, "readme")) {
    Readme.main();
    return 0;
  }
  if (getNoArg(parsed, "help")) {
    process.stdout.write(usage());
    return 0;
  }

  const built = buildCompareFlags(parsed);
  if ("kind" in built && built.kind === "MakeConfig") {
    await MakeConfig.main(built.file);
    return 0;
  }
  const flags = built as CompareFlags;
  const result = runCompare(flags);
  return result === "Same" ? 0 : 1;
};

// ----- usage ---------------------------------------------------------------

const summary = `Compare two files (or process a diff read in on stdin) using the
patience diff algorithm.

If you don't supply any arguments to patdiff, it will read diff-like
text from stdin and color it in the normal patdiff way.

The file ~/.patdiff is used as a config file if it exists.  You can
write a sample config with the -make-config flag.`;

export const usage = (): string => `\
${summary}

  patdiff [FLAG ...] [FILE1 FILE2]

Flags:
  -default                      Use the default configuration instead of ~/.patdiff
  -file FILE                    Use FILE as configuration file instead of ~/.patdiff
  -context NUM                  Show NUM lines of unchanged context
  -line-big-enough NUM          Limit line-level semantic cleanup
  -word-big-enough NUM          Limit word-level semantic cleanup
  -no-semantic-cleanup          Don't do any semantic cleanup
  -unrefined                    Don't highlight word differences between lines
  -keep-whitespace              Consider whitespace when comparing lines
  -split-long-lines             Split long lines
  -no-interleave                Don't split up large hunks near equalities
  -text                         Treat all files as text
  -html | -ascii | -ansi        Choose output format (default: ansi)
  -dont-produce-unified-lines   Don't produce unified lines
  -quiet                        Report only whether files differ
  -shallow                      Don't recurse into subdirs
  -double-check                 If files seem identical, double check with cmp
  -mask-uniques                 Don't compare against /dev/null
  -float-tolerance PERCENT      Consider floats equal within PERCENT
  -alt-prev NAME                Mask prev filename with NAME
  -alt-next NAME                Mask next filename with NAME
  -make-config FILE             Write default configuration file
  -include REGEXP               Include files matching pattern (dirs only)
  -exclude REGEXP               Exclude files matching pattern (dirs only)
  -reverse                      Produce a diff that undoes the changes
  -location-style STYLE         diff|omake|none|separator
  -warn-if-no-trailing-newline-in-both BOOL
  -find-moves                   Try to find and render moves
  -side-by-side wrap|truncate   Render a diff side by side
  -width N                      Columns to use for side-by-side
  -readme                       Display documentation
  -version                      Print version
  -help                         This usage text
`;

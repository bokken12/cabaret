/** Node-flavored compare_core: reads files from disk and walks directories.
 *  Mirrors OCaml's [Patdiff.Compare_core]. */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { make as makeKernelCompare } from "../kernel/compare-core.js";
import type { CompareCoreS } from "../kernel/compare-core-types.js";
import * as ComparisonResult from "../kernel/comparison-result.js";
import type { Configuration } from "../kernel/configuration.js";
import * as FileHelpers from "../kernel/file-helpers.js";
import * as FileName from "../kernel/file-name.js";
import type { Hunks } from "../kernel/hunks.js";
import * as IsBinary from "../kernel/is-binary.js";

import { withNodeIo } from "./patdiff-core.js";

export { make as makeFromPatdiffCore, withoutUnix } from "../kernel/compare-core.js";
export type {
  CompareCoreS,
  CompareLinesResult,
  DiffResult,
} from "../kernel/compare-core-types.js";

/** [CompareCoreS] backed by the Node-aware [PatdiffCore]. */
export const withNodeIoCompare: CompareCoreS = makeKernelCompare(withNodeIo);

/** Read both files and compute the [ComparisonResult]. */
export const compareFiles = (args: {
  config: Configuration;
  prevFile: FileName.FileName;
  nextFile: FileName.FileName;
}): ComparisonResult.ComparisonResult => {
  const { config, prevFile, nextFile } = args;
  const prevBytes = fs.readFileSync(FileName.realNameExn(prevFile));
  const nextBytes = fs.readFileSync(FileName.realNameExn(nextFile));
  // Detect binaries on raw bytes: decoding first maps invalid UTF-8 to U+FFFD,
  // which can make byte-different binaries compare equal.
  if (!config.assumeText) {
    const prevIsBinary = IsBinary.bytes(prevBytes);
    const nextIsBinary = IsBinary.bytes(nextBytes);
    if (prevIsBinary || nextIsBinary) {
      if (prevBytes.equals(nextBytes)) return { kind: "BinarySame" };
      return { kind: "BinaryDifferent", prevIsBinary, nextIsBinary };
    }
  }
  return ComparisonResult.create({
    config,
    prev: { name: FileName.displayName(prevFile), text: prevBytes.toString("utf8") },
    next: { name: FileName.displayName(nextFile), text: nextBytes.toString("utf8") },
    compareAssumingText: ({ config: cfg, prev: p, next: n }) => {
      const [prevLines, prevNl] = FileHelpers.linesOfContents(p.text);
      const [nextLines, nextNl] = FileHelpers.linesOfContents(n.text);
      FileHelpers.warnIfNoTrailingNewline({
        warn: (s) => process.stderr.write(`No newline at the end of ${s}\n`),
        prev: [prevNl, p.name],
        next: [nextNl, n.name],
        warnIfNoTrailingNewlineInBoth: cfg.warnIfNoTrailingNewlineInBoth,
      });
      const cl = withNodeIoCompare.compareLines({
        config: cfg,
        prev: prevLines,
        next: nextLines,
      });
      if (cl.kind === "Hunks") return { kind: "Hunks", hunks: cl.hunks };
      return { kind: "StructuredHunks", hunks: cl.hunks };
    },
  });
};

/** Print the comparison result to stdout, matching OCaml's [print]. */
export const print = (args: {
  result: ComparisonResult.ComparisonResult;
  fileNames: readonly [FileName.FileName, FileName.FileName];
  config: Configuration;
}): void => {
  const { result, fileNames, config } = args;
  const [prevFile, nextFile] = fileNames;
  if (ComparisonResult.hasNoDiff(result)) {
    if (config.doubleCheck) {
      const cmd = `cmp -s ${shellQuote(FileName.realNameExn(prevFile))} ${shellQuote(FileName.realNameExn(nextFile))}`;
      try {
        execSync(cmd, { stdio: "ignore" });
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 1) {
          process.stdout.write("There are no differences except those filtered by your settings\n");
        }
      }
    }
    return;
  }
  if (config.quiet) return;
  switch (result.kind) {
    case "BinarySame":
      throw new Error("Compare_core.print: BinarySame impossible after hasNoDiff");
    case "BinaryDifferent": {
      const msg = FileHelpers.binaryDifferentMessage({
        config,
        prevFile,
        prevIsBinary: result.prevIsBinary,
        nextFile,
        nextIsBinary: result.nextIsBinary,
      });
      process.stdout.write(msg + "\n");
      return;
    }
    case "Hunks":
      withNodeIo.printUnified({
        fileNames,
        rules: config.rules,
        output: config.output,
        locationStyle: config.locationStyle,
        hunks: result.hunks as Hunks,
      });
      return;
    case "StructuredHunks":
      withNodeIo.printSideBySide({
        ...(config.widthOverride !== undefined ? { widthOverride: config.widthOverride } : {}),
        fileNames,
        rules: config.rules,
        wrapOrTruncate: config.sideBySide ?? "wrap",
        output: config.output,
        hunks: result.hunks,
      });
      return;
  }
};

const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

const withAlt = (
  config: Configuration,
  prev: string,
  next: string,
): readonly [FileName.FileName, FileName.FileName] => [
  FileName.real(prev, config.prevAlt),
  FileName.real(next, config.nextAlt),
];

const diffFilesInternal = (args: {
  config: Configuration;
  prevFile: FileName.FileName;
  nextFile: FileName.FileName;
}): "Same" | "Different" => {
  const { config, prevFile, nextFile } = args;
  const result = compareFiles({ config, prevFile, nextFile });
  print({ result, fileNames: [prevFile, nextFile], config });
  return ComparisonResult.hasNoDiff(result) ? "Same" : "Different";
};

/** Diff two files by path. Prints output to stdout. */
export const diffFiles = (args: {
  config: Configuration;
  prevFile: string;
  nextFile: string;
}): "Same" | "Different" => {
  const [prevFile, nextFile] = withAlt(args.config, args.prevFile, args.nextFile);
  return diffFilesInternal({ config: args.config, prevFile, nextFile });
};

const isReg = (file: FileName.FileName): boolean => {
  try {
    return fs.statSync(FileName.realNameExn(file)).isFile();
  } catch {
    return false;
  }
};

const isDir = (file: FileName.FileName): boolean => {
  try {
    return fs.statSync(FileName.realNameExn(file)).isDirectory();
  } catch {
    return false;
  }
};

export type FileFilter = (args: { path: string; stats: fs.Stats }) => boolean;

const setOfDir = (dir: FileName.FileName, fileFilter: FileFilter | undefined): ReadonlySet<string> => {
  const dirPath = FileName.realNameExn(dir);
  const entries = fs.readdirSync(dirPath);
  const out = new Set<string>();
  for (const name of entries) {
    const full = path.join(dirPath, name);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(full);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "ENOENT") continue;
      throw e;
    }
    if (fileFilter !== undefined && !fileFilter({ path: full, stats })) continue;
    out.add(name);
  }
  return out;
};

const diffDirsInternal = (args: {
  config: Configuration;
  prevDir: FileName.FileName;
  nextDir: FileName.FileName;
  fileFilter: FileFilter | undefined;
}): "Same" | "Different" => {
  const { config, prevDir, nextDir, fileFilter } = args;
  if (!isDir(prevDir)) throw new Error("diffDirs: prevDir is not a directory");
  if (!isDir(nextDir)) throw new Error("diffDirs: nextDir is not a directory");
  const prevSet = setOfDir(prevDir, fileFilter);
  const nextSet = setOfDir(nextDir, fileFilter);
  const prevUniques: string[] = [];
  const nextUniques: string[] = [];
  for (const f of prevSet) if (!nextSet.has(f)) prevUniques.push(f);
  for (const f of nextSet) if (!prevSet.has(f)) nextUniques.push(f);
  prevUniques.sort();
  nextUniques.sort();
  const inter: string[] = [];
  for (const f of prevSet) if (nextSet.has(f)) inter.push(f);
  inter.sort();

  const handleUnique = (which: "Prev" | "Next", file: string, dir: FileName.FileName): void => {
    process.stdout.write(`Only in ${FileName.toStringHum(dir)}: ${file}\n`);
    if (!config.maskUniques) {
      const filePath = FileName.append(dir, file);
      if (isReg(filePath)) {
        const nullFile = FileName.devNull;
        if (which === "Prev") {
          diffFilesInternal({ config, prevFile: filePath, nextFile: nullFile });
        } else {
          diffFilesInternal({ config, prevFile: nullFile, nextFile: filePath });
        }
      }
    }
  };
  for (const f of prevUniques) handleUnique("Prev", f, prevDir);
  for (const f of nextUniques) handleUnique("Next", f, nextDir);

  let exitCode: "Same" | "Different" = "Same";
  for (const file of inter) {
    const prevFile = FileName.append(prevDir, file);
    const nextFile = FileName.append(nextDir, file);
    if (isReg(prevFile) && isReg(nextFile)) {
      const result = compareFiles({ config, prevFile, nextFile });
      if (!ComparisonResult.hasNoDiff(result)) {
        exitCode = "Different";
        if (config.quiet) {
          process.stdout.write(
            `Files ${FileName.toStringHum(prevFile)} and ${FileName.toStringHum(nextFile)} differ\n`,
          );
        } else {
          print({ result, fileNames: [prevFile, nextFile], config });
        }
      }
    } else if (isDir(prevFile) && isDir(nextFile)) {
      if (!config.shallow) {
        const r = diffDirsInternal({
          config,
          prevDir: prevFile,
          nextDir: nextFile,
          fileFilter,
        });
        if (r === "Different") exitCode = "Different";
      } else {
        process.stdout.write(
          `Common subdirectories: ${FileName.toStringHum(prevFile)} and ${FileName.toStringHum(nextFile)}\n`,
        );
      }
    } else {
      exitCode = "Different";
      process.stdout.write(
        `Files ${FileName.toStringHum(prevFile)} and ${FileName.toStringHum(nextFile)} are not the same type\n`,
      );
    }
  }
  if (prevUniques.length === 0 && nextUniques.length === 0) return exitCode;
  return "Different";
};

/** Diff two directories by path. Prints output to stdout. */
export const diffDirs = (args: {
  config: Configuration;
  prevDir: string;
  nextDir: string;
  fileFilter?: FileFilter;
}): "Same" | "Different" => {
  const [prevDir, nextDir] = withAlt(args.config, args.prevDir, args.nextDir);
  if (!isDir(prevDir)) {
    throw new Error(`diffDirs: prev_dir '${FileName.toStringHum(prevDir)}' is not a directory`);
  }
  if (!isDir(nextDir)) {
    throw new Error(`diffDirs: next_dir '${FileName.toStringHum(nextDir)}' is not a directory`);
  }
  return diffDirsInternal({
    config: args.config,
    prevDir,
    nextDir,
    fileFilter: args.fileFilter,
  });
};

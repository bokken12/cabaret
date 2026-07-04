import { splitLines } from "../shared/string-util.js";
import type { Configuration } from "./configuration.js";
import * as FileName from "./file-name.js";
import { LocationStyle } from "./format.js";

export type TrailingNewline = "MissingTrailingNewline" | "WithTrailingNewline";

export const linesOfContents = (contents: string): readonly [readonly string[], TrailingNewline] => {
  const lines = splitLines(contents);
  const hasTrailing: TrailingNewline =
    contents.length === 0 || contents[contents.length - 1] === "\n" ? "WithTrailingNewline" : "MissingTrailingNewline";
  return [lines, hasTrailing];
};

export const warnIfNoTrailingNewline = (args: {
  warnIfNoTrailingNewlineInBoth: boolean;
  warn: (s: string) => void;
  prev: readonly [TrailingNewline, string];
  next: readonly [TrailingNewline, string];
}): void => {
  const [prevNl, prevFile] = args.prev;
  const [nextNl, nextFile] = args.next;
  if (prevNl === "WithTrailingNewline" && nextNl === "WithTrailingNewline") return;
  if (prevNl === "WithTrailingNewline" && nextNl === "MissingTrailingNewline") {
    args.warn(nextFile);
    return;
  }
  if (prevNl === "MissingTrailingNewline" && nextNl === "WithTrailingNewline") {
    args.warn(prevFile);
    return;
  }
  if (args.warnIfNoTrailingNewlineInBoth) {
    args.warn(prevFile);
    args.warn(nextFile);
  }
};

export const binaryDifferentMessage = (args: {
  config: Configuration;
  prevFile: FileName.FileName;
  prevIsBinary: boolean;
  nextFile: FileName.FileName;
  nextIsBinary: boolean;
}): string => {
  const { config, prevFile, prevIsBinary, nextFile, nextIsBinary } = args;
  switch (config.locationStyle) {
    case "Diff":
    case "None":
    case "Separator": {
      const prevBin = prevIsBinary ? " (binary)" : "";
      const nextBin = nextIsBinary ? " (binary)" : "";
      return `Files ${FileName.toStringHum(prevFile)}${prevBin} and ${FileName.toStringHum(nextFile)}${nextBin} differ`;
    }
    case "Omake":
      return (
        LocationStyle.omakeStyleErrorMessageStart({
          file: FileName.displayName(prevFile),
          line: 1,
        }) + `\n  File "${FileName.toStringHum(nextFile)}"\n  binary files differ\n`
      );
  }
};

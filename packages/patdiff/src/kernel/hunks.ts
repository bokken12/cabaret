import type { Hunk } from "../patience-diff/hunk.js";

export type Hunks = readonly Hunk<string>[];

export const iter_ = (args: {
  fHunkBreak: (hunk: Hunk<string>) => void;
  fLine: (line: string) => void;
  hunks: Hunks;
}): void => {
  const { fHunkBreak, fLine, hunks } = args;
  for (const hunk of hunks) {
    fHunkBreak(hunk);
    for (const range of hunk.ranges) {
      switch (range.kind) {
        case "same":
          for (const [, next] of range.contents) fLine(next);
          break;
        case "prev":
        case "next":
        case "unified":
          for (const line of range.contents) fLine(line);
          break;
        case "replace":
          for (const line of range.prev) fLine(line);
          for (const line of range.next) fLine(line);
          break;
      }
    }
  }
};

export const iter = (args: {
  fHunkBreak: (prev: readonly [number, number], next: readonly [number, number]) => void;
  fLine: (line: string) => void;
  hunks: Hunks;
}): void => {
  const { fHunkBreak, fLine, hunks } = args;
  iter_({
    fHunkBreak: (hunk) => fHunkBreak([hunk.prevStart, hunk.prevSize], [hunk.nextStart, hunk.nextSize]),
    fLine,
    hunks,
  });
};

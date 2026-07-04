/** Single-column rendering: builds and prints unified diffs. Mirrors OCaml's
 *  [Output_ops.Single_column]. */

import type { Hunk } from "../../patience-diff/hunk.js";
import { Range } from "../../patience-diff/range.js";
import type { FileName } from "../file-name.js";
import type * as Format from "../format.js";
import type { Hunks } from "../hunks.js";
import { iter_ as hunksIter } from "../hunks.js";
import type { S as OutputS } from "../output.js";

const formatRange = (args: {
  readonly rules: Format.Rules;
  readonly outputImpl: OutputS;
  readonly range: Range<string>;
}): Range<string> => {
  const { rules, outputImpl, range } = args;
  const apply = (text: string, rule: Format.Rule, refined: boolean): string =>
    outputImpl.applyRule(text, { rule, refined });
  switch (range.kind) {
    case "same": {
      const pairs = range.contents.map(([x, y]) => {
        return [apply(x, rules.lineSame, false), apply(y, rules.lineSame, false)] as const;
      });
      return Range.same(pairs);
    }
    case "next": {
      const rule =
        range.moveKind === undefined
          ? rules.lineNext
          : range.moveKind.kind === "move"
            ? rules.movedToNext
            : rules.addedInMove;
      const contents = range.contents.map((c) => apply(c, rule, false));
      return Range.next(contents, range.moveKind);
    }
    case "prev": {
      const rule =
        range.moveKind === undefined
          ? rules.linePrev
          : range.moveKind.kind === "move"
            ? rules.movedFromPrev
            : rules.removedInMove;
      const contents = range.contents.map((c) => apply(c, rule, false));
      return Range.prev(contents, range.moveKind);
    }
    case "unified": {
      const rule = range.moveId === undefined ? rules.lineUnified : rules.lineUnifiedInMove;
      const contents = range.contents.map((c) => apply(c, rule, true));
      return Range.unified(contents, range.moveId);
    }
    case "replace": {
      const [prevRule, nextRule] =
        range.moveId === undefined ? [rules.linePrev, rules.lineNext] : [rules.removedInMove, rules.addedInMove];
      const prev = range.prev.map((c) => apply(c, prevRule, true));
      const next = range.next.map((c) => apply(c, nextRule, true));
      return Range.replace(prev, next, range.moveId);
    }
  }
};

const rangesToStrings = (args: {
  readonly rules: Format.Rules;
  readonly outputImpl: OutputS;
  readonly hunks: Hunks;
}): Hunks => {
  const { rules, outputImpl, hunks } = args;
  return hunks.map((hunk) => ({
    ...hunk,
    ranges: hunk.ranges.map((range) => formatRange({ rules, outputImpl, range })),
  }));
};

export const buildUnified = (args: {
  readonly rules: Format.Rules;
  readonly outputImpl: OutputS;
  readonly hunks: Hunks;
}): readonly (readonly string[])[] => {
  const formattedHunks = rangesToStrings({
    rules: args.rules,
    outputImpl: args.outputImpl,
    hunks: args.hunks,
  });
  const blocks: string[][] = [];
  let current: string[] | undefined;
  const fLine = (line: string): void => {
    if (current === undefined) current = [line];
    else current.push(line);
  };
  const fHunkBreak = (_: Hunk<string>): void => {
    current = [];
    blocks.push(current);
  };
  hunksIter({ fHunkBreak, fLine, hunks: formattedHunks });
  // Trim trailing empty blocks introduced by fHunkBreak for hunks with no content.
  return blocks;
};

export const printUnified = (args: {
  readonly printGlobalHeader: boolean;
  readonly fileNames: readonly [FileName, FileName];
  readonly rules: Format.Rules;
  readonly outputImpl: OutputS;
  readonly print: (s: string) => void;
  readonly locationStyle: Format.LocationStyle;
  readonly hunks: Hunks;
}): void => {
  const formattedHunks = rangesToStrings({
    rules: args.rules,
    outputImpl: args.outputImpl,
    hunks: args.hunks,
  });
  args.outputImpl.print({
    printGlobalHeader: args.printGlobalHeader,
    fileNames: args.fileNames,
    rules: args.rules,
    print: args.print,
    locationStyle: args.locationStyle,
    hunks: formattedHunks,
  });
};

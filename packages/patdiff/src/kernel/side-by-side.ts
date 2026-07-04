/** Side-by-side rendering of structured hunks. Mirrors OCaml's [side_by_side.ml] plus
 *  the [Output_ops.Double_column] submodule of [patdiff_core.ml].
 *
 *  A previous-file line will only ever have [Prev] and [Same] tagged segments; a
 *  next-file line will only ever have [Next] and [Same] tagged segments. */

import * as AnsiText from "../ansi-text/ansi-text.js";
import type { Hunk } from "../patience-diff/hunk.js";
import type { MoveId } from "../patience-diff/move-id.js";
import type { FileName } from "./file-name.js";
import * as FileNameMod from "./file-name.js";
import * as Format from "./format.js";
import type { Output, S as OutputS } from "./output.js";
import type { StructuredHunks, StructuredLine } from "./patdiff-core-types.js";

const MIN_COL_WIDTH = 60;

// ---------- Line ----------

export type Tag = "Next" | "Prev" | "Same";

export type Line = {
  readonly lineNumber: number | undefined;
  readonly contents: readonly (readonly [Tag, AnsiText.T])[];
};

export const Line = {
  empty: { lineNumber: undefined, contents: [] } as Line,

  toString: (t: Line): string => t.contents.map(([, text]) => AnsiText.toUnstyled(text)).join(""),

  width: (t: Line): number => t.contents.reduce((acc, [, text]) => acc + AnsiText.width(text), 0),

  anyNonSame: (t: Line): boolean => t.contents.some(([tag]) => tag !== "Same"),

  /** Apply [style] to each phrase, then concatenate. Mirrors OCaml's [styled_string]. */
  styledString: (t: Line, args: { output?: Output; style: (tag: Tag, s: string) => string }): string => {
    const output: Output = args.output ?? "Ansi";
    const segments = t.contents.map(([tag, text]) => {
      const raw = output === "Ansi" ? AnsiText.toString(text) : AnsiText.toUnstyled(text);
      return args.style(tag, raw);
    });
    return segments.join("");
  },

  /** Wrap [t] so no rendered line exceeds [width]. The first sub-line keeps the line
   *  number; subsequent sub-lines have [lineNumber = undefined]. */
  wrap: (t: Line, args: { width: number }): readonly Line[] => {
    const maxWidth = args.width;
    if (maxWidth <= 1) throw new Error("width is too narrow");

    type Segment = readonly [Tag, AnsiText.T];

    // Wrap a single AnsiText into chunks of width <= maxWidth.
    const wrapAnsi = (text: AnsiText.T): AnsiText.T[] => {
      const out: AnsiText.T[] = [];
      let cur = text;
      while (AnsiText.width(cur) > maxWidth) {
        const [prefix, suffix] = AnsiText.split(maxWidth, cur);
        out.push(prefix);
        cur = suffix;
      }
      out.push(cur);
      return out;
    };

    // Build lines as arrays of segments.
    const lines: Segment[][] = [];
    let curLine: Segment[] = [];
    let curLen = 0;

    for (const [tag, text] of t.contents) {
      const wordLen = AnsiText.width(text);
      if (curLen + wordLen <= maxWidth) {
        curLine.push([tag, text]);
        curLen += wordLen;
        continue;
      }
      // Split current text at maxWidth - curLen
      const [wordStart, wordRest] = AnsiText.split(maxWidth - curLen, text);
      curLine.push([tag, wordStart]);
      // Push the current full line.
      lines.push(curLine);
      // Now distribute wordRest across new lines.
      const chunks = wrapAnsi(wordRest);
      if (chunks.length === 0) {
        curLine = [];
        curLen = 0;
      } else if (chunks.length === 1) {
        curLine = [[tag, chunks[0]!]];
        curLen = AnsiText.width(chunks[0]!);
      } else {
        // All but the last chunk become standalone lines.
        for (let i = 0; i < chunks.length - 1; i++) {
          lines.push([[tag, chunks[i]!]]);
        }
        const last = chunks[chunks.length - 1]!;
        curLine = [[tag, last]];
        curLen = AnsiText.width(last);
      }
    }
    if (curLine.length > 0) lines.push(curLine);

    if (lines.length === 0) return [t];

    return lines.map((segs, i) => ({
      lineNumber: i === 0 ? t.lineNumber : undefined,
      contents: segs,
    }));
  },

  /** Truncate [t] to at most [width] visible characters. */
  truncate: (t: Line, args: { width: number }): Line => {
    const width = args.width;
    const out: (readonly [Tag, AnsiText.T])[] = [];
    let len = 0;
    for (const [tag, text] of t.contents) {
      const w = AnsiText.width(text);
      if (w + len > width) {
        const before = AnsiText.truncate(text, { width: width - len });
        out.push([tag, before]);
        break;
      }
      out.push([tag, text]);
      len += w;
    }
    return { lineNumber: t.lineNumber, contents: out };
  },
};

// ---------- LineInfo ----------

export type LineInfo =
  | { readonly kind: "Same"; readonly prev: Line; readonly next: Line }
  | {
      readonly kind: "Prev";
      readonly line: Line;
      readonly moveId: MoveId | undefined;
    }
  | {
      readonly kind: "Next";
      readonly line: Line;
      readonly moveId: MoveId | undefined;
    };

export const LineInfo = {
  same: (prev: Line, next: Line): LineInfo => ({ kind: "Same", prev, next }),
  prev: (line: Line, moveId: MoveId | undefined): LineInfo => ({
    kind: "Prev",
    line,
    moveId,
  }),
  next: (line: Line, moveId: MoveId | undefined): LineInfo => ({
    kind: "Next",
    line,
    moveId,
  }),

  /** Wrap a [LineInfo]. For [Same], both sides are wrapped and padded with empty lines
   *  so they have the same length. */
  wrap: (args: { width: number }, t: LineInfo): readonly LineInfo[] => {
    const { width } = args;
    switch (t.kind) {
      case "Prev":
        return Line.wrap(t.line, { width }).map((ln) => LineInfo.prev(ln, t.moveId));
      case "Next":
        return Line.wrap(t.line, { width }).map((ln) => LineInfo.next(ln, t.moveId));
      case "Same": {
        const prevs = Line.wrap(t.prev, { width });
        const nexts = Line.wrap(t.next, { width });
        const extraPrev = Math.max(0, prevs.length - nexts.length);
        const extraNext = Math.max(0, nexts.length - prevs.length);
        const paddedPrevs: Line[] = [...prevs];
        for (let i = 0; i < extraNext; i++) paddedPrevs.push(Line.empty);
        const paddedNexts: Line[] = [...nexts];
        for (let i = 0; i < extraPrev; i++) paddedNexts.push(Line.empty);
        const out: LineInfo[] = [];
        for (let i = 0; i < paddedPrevs.length; i++) {
          out.push(LineInfo.same(paddedPrevs[i]!, paddedNexts[i]!));
        }
        return out;
      }
    }
  },

  truncate: (args: { width: number }, t: LineInfo): LineInfo => {
    const { width } = args;
    switch (t.kind) {
      case "Same":
        return LineInfo.same(Line.truncate(t.prev, { width }), Line.truncate(t.next, { width }));
      case "Prev":
        return LineInfo.prev(Line.truncate(t.line, { width }), t.moveId);
      case "Next":
        return LineInfo.next(Line.truncate(t.line, { width }), t.moveId);
    }
  },

  /** Returns [prev, next] lines, padding one side with empty if not [Same]. */
  lines: (t: LineInfo): readonly [Line, Line] => {
    switch (t.kind) {
      case "Same":
        return [t.prev, t.next];
      case "Prev":
        return [t.line, Line.empty];
      case "Next":
        return [Line.empty, t.line];
    }
  },
};

// ---------- hunksToLines ----------

type LineIndex = { hunkIndex: number; lineIndex: number };

type ParsedLine = readonly (readonly [Tag, AnsiText.T])[];

const remapTags =
  (from: Tag, to: Tag) =>
  (contents: ParsedLine): ParsedLine =>
    contents.map(([tag, text]) => [tag === from ? to : tag, text] as const);

const sameToPrev = remapTags("Same", "Prev");
const sameToNext = remapTags("Same", "Next");

const toContents = (line: readonly StructuredLine[]): ParsedLine =>
  line.map(([tag, text]) => [tag, AnsiText.parse(text)] as const);

/** Align replacement lines using the OCaml [align_replace_lines] heuristic that
 *  preserves "same" word counts. */
const alignReplaceLines = (
  getPrevLineNumber: () => number,
  getNextLineNumber: () => number,
  hunkQueue: LineInfo[],
  prevLines: readonly (readonly (readonly [Tag, AnsiText.T])[])[],
  nextLines: readonly (readonly (readonly [Tag, AnsiText.T])[])[],
): void => {
  let prevIdx = 0;
  let nextIdx = 0;
  let numSameWordsPrev = 0;
  let numSameWordsNext = 0;

  const numSame = (contents: readonly (readonly [Tag, AnsiText.T])[]): number => {
    let n = 0;
    for (const [tag, text] of contents) {
      if (tag === "Same" && !AnsiText.isEmpty(text)) n++;
    }
    return n;
  };

  for (;;) {
    const prevContents = prevIdx < prevLines.length ? prevLines[prevIdx]! : undefined;
    const nextContents = nextIdx < nextLines.length ? nextLines[nextIdx]! : undefined;
    if (prevContents === undefined && nextContents === undefined) return;
    if (prevContents !== undefined && nextContents === undefined) {
      hunkQueue.push(LineInfo.prev({ lineNumber: getPrevLineNumber(), contents: prevContents }, undefined));
      prevIdx++;
      continue;
    }
    if (prevContents === undefined && nextContents !== undefined) {
      hunkQueue.push(LineInfo.next({ lineNumber: getNextLineNumber(), contents: nextContents }, undefined));
      nextIdx++;
      continue;
    }
    // Both defined.
    const pc = prevContents!;
    const nc = nextContents!;
    const numSamePrevLine = numSame(pc);
    const numSameNextLine = numSame(nc);
    const newNumSamePrev = numSameWordsPrev + numSamePrevLine;
    const newNumSameNext = numSameWordsNext + numSameNextLine;
    if (newNumSamePrev <= numSameWordsNext) {
      hunkQueue.push(LineInfo.prev({ lineNumber: getPrevLineNumber(), contents: pc }, undefined));
      prevIdx++;
      numSameWordsPrev = newNumSamePrev;
    } else if (newNumSameNext <= numSameWordsPrev) {
      hunkQueue.push(LineInfo.next({ lineNumber: getNextLineNumber(), contents: nc }, undefined));
      nextIdx++;
      numSameWordsNext = newNumSameNext;
    } else {
      hunkQueue.push(
        LineInfo.same(
          { lineNumber: getPrevLineNumber(), contents: pc },
          { lineNumber: getNextLineNumber(), contents: nc },
        ),
      );
      prevIdx++;
      nextIdx++;
      numSameWordsPrev = newNumSamePrev;
      numSameWordsNext = newNumSameNext;
    }
  }
};

/** Take structured hunks and produce hunks of [LineInfo].
 *  Mirrors OCaml's [hunks_to_lines]. */
export const hunksToLines = (hunks: StructuredHunks): readonly (readonly LineInfo[])[] => {
  const result: LineInfo[][] = [];
  let prevLineNumber = 1;
  let nextLineNumber = 1;
  const startOfMoveInPrev = new Map<MoveId, LineIndex>();

  const currentLineIndex = (): LineIndex => {
    const hunkIndex = result.length - 1;
    const lineIndex = result.length === 0 ? 0 : result[hunkIndex]!.length;
    return { hunkIndex, lineIndex };
  };

  const recordMoveInPrev = (moveId: MoveId): void => {
    if (!startOfMoveInPrev.has(moveId)) {
      startOfMoveInPrev.set(moveId, currentLineIndex());
    }
  };

  const getAndBumpPrev = (): number => {
    const v = prevLineNumber;
    prevLineNumber++;
    return v;
  };
  const getAndBumpNext = (): number => {
    const v = nextLineNumber;
    nextLineNumber++;
    return v;
  };

  // Moves may have been refined; remember the next parts so we can rewrite the prev
  // part of the move with the refinement we found.
  type RangeForLine = Hunk<readonly StructuredLine[]>["ranges"][number];
  const nextsByMoveId = new Map<MoveId, RangeForLine[]>();
  const recordNextMove = (moveId: MoveId, range: RangeForLine): void => {
    const existing = nextsByMoveId.get(moveId);
    if (existing === undefined) {
      nextsByMoveId.set(moveId, [range]);
    } else {
      existing.push(range);
    }
  };

  for (const hunk of hunks) {
    prevLineNumber = hunk.prevStart;
    nextLineNumber = hunk.nextStart;
    const hunkQueue: LineInfo[] = [];
    result.push(hunkQueue);

    for (const range of hunk.ranges) {
      switch (range.kind) {
        case "same": {
          for (const [prevLine, nextLine] of range.contents) {
            hunkQueue.push(
              LineInfo.same(
                {
                  lineNumber: getAndBumpPrev(),
                  contents: toContents(prevLine),
                },
                {
                  lineNumber: getAndBumpNext(),
                  contents: toContents(nextLine),
                },
              ),
            );
          }
          break;
        }
        case "prev": {
          const moveKind = range.moveKind;
          if (moveKind !== undefined && moveKind.kind === "withinMove") {
            recordNextMove(moveKind.moveId, range);
          }
          for (const lineContents of range.contents) {
            const contents = toContents(lineContents);
            if (moveKind === undefined) {
              hunkQueue.push(
                LineInfo.prev(
                  {
                    lineNumber: getAndBumpPrev(),
                    contents: sameToPrev(contents),
                  },
                  undefined,
                ),
              );
            } else if (moveKind.kind === "move") {
              recordMoveInPrev(moveKind.moveId);
              hunkQueue.push(LineInfo.prev({ lineNumber: getAndBumpPrev(), contents }, moveKind.moveId));
            } else {
              // withinMove: don't enqueue; OCaml only records the next-move position.
              void contents;
            }
          }
          break;
        }
        case "next": {
          const moveKind = range.moveKind;
          if (moveKind !== undefined && moveKind.kind === "move") {
            recordNextMove(moveKind.moveId, range);
          }
          for (const lineContents of range.contents) {
            const contents = toContents(lineContents);
            if (moveKind === undefined) {
              hunkQueue.push(
                LineInfo.next(
                  {
                    lineNumber: getAndBumpNext(),
                    contents: sameToNext(contents),
                  },
                  undefined,
                ),
              );
            } else if (moveKind.kind === "move") {
              hunkQueue.push(LineInfo.next({ lineNumber: getAndBumpNext(), contents }, moveKind.moveId));
            } else {
              // withinMove
              hunkQueue.push(
                LineInfo.next(
                  {
                    lineNumber: getAndBumpNext(),
                    contents: sameToNext(contents),
                  },
                  moveKind.moveId,
                ),
              );
            }
          }
          break;
        }
        case "replace": {
          const moveId = range.moveId;
          if (moveId === undefined) {
            alignReplaceLines(
              getAndBumpPrev,
              getAndBumpNext,
              hunkQueue,
              range.prev.map(toContents),
              range.next.map(toContents),
            );
          } else {
            recordNextMove(moveId, range);
            for (const lineContents of range.next) {
              const contents = toContents(lineContents);
              hunkQueue.push(LineInfo.next({ lineNumber: getAndBumpNext(), contents }, moveId));
            }
          }
          break;
        }
        case "unified":
          throw new Error("Cannot turn unified ranges into side by side view");
      }
    }
  }

  // Rewrite prevs that were refined in moves. For each move we know the start
  // position of its [Prev] entries in the [result] grid; walk the recorded next
  // ranges and patch them.
  for (const [moveId, ranges] of nextsByMoveId) {
    const start = startOfMoveInPrev.get(moveId);
    if (start === undefined) continue;
    const cursor: LineIndex = { hunkIndex: start.hunkIndex, lineIndex: start.lineIndex };
    for (const range of ranges) {
      if (range.kind === "prev" && range.moveKind !== undefined) {
        // OCaml: Prev with [Some _]: rewrite tags, then overwrite contents.
        for (const lineContents of range.contents) {
          const newContents = sameToPrev(toContents(lineContents));
          const target = result[cursor.hunkIndex]?.[cursor.lineIndex];
          if (target !== undefined && target.kind === "Prev") {
            result[cursor.hunkIndex]![cursor.lineIndex] = LineInfo.prev(
              { lineNumber: target.line.lineNumber, contents: newContents },
              target.moveId,
            );
          }
          cursor.lineIndex++;
        }
      } else if (range.kind === "replace" && range.moveId !== undefined) {
        // Replace already refined, contents are correct from refinement; just copy.
        for (const lineContents of range.prev) {
          const newContents = toContents(lineContents);
          const target = result[cursor.hunkIndex]?.[cursor.lineIndex];
          if (target !== undefined && target.kind === "Prev") {
            result[cursor.hunkIndex]![cursor.lineIndex] = LineInfo.prev(
              { lineNumber: target.line.lineNumber, contents: newContents },
              target.moveId,
            );
          }
          cursor.lineIndex++;
        }
      } else if (range.kind === "next") {
        // Skip ahead in the prev-grid by however many lines were on the next side
        // for [Move _] (the prev side has a corresponding entry per line).
        if (range.moveKind !== undefined && range.moveKind.kind === "move") {
          cursor.lineIndex += range.contents.length;
        }
      }
    }
  }

  return result;
};

// ---------- Build / Print / OutputToString ----------

export type WrapOrTruncate = "wrap" | "truncate" | "neither";
export type SideBySideMode = "wrap" | "truncate";

const lineNumText = (lineNum: number | undefined, len: number): string => {
  const n = lineNum === undefined ? "" : String(lineNum);
  return n.padStart(len, " ") + " ";
};

const createPadding = (len: number): string => " ".repeat(Math.max(0, len));

const maxLineNumber = (hunks: readonly Hunk<readonly StructuredLine[]>[]): number => {
  let m = 0;
  for (const hunk of hunks) {
    m = Math.max(m, hunk.prevStart + hunk.prevSize - 1, hunk.nextStart + hunk.nextSize - 1);
  }
  return m;
};

const makeDivider = (output: Output): string => {
  switch (output) {
    case "Ansi":
    case "Html":
      return "│"; // │
    case "Ascii":
      return "|";
  }
};

const defaultDoubleColumnWidth = 121;

/** Default [computeWidth]: no console-width detection; matches OCaml when
 *  [Output_impls.console_width] returns [Error _]. */
const defaultComputeWidth = (widthOverride?: number): number => {
  if (widthOverride !== undefined) return widthOverride;
  return defaultDoubleColumnWidth;
};

const getGutters = (args: {
  readonly wrapped: boolean;
  readonly rules: Format.Rules;
  readonly outputImpl: OutputS;
  readonly line: LineInfo;
}): readonly [string, string] => {
  const { wrapped, rules, outputImpl, line } = args;
  const prefixColumnWidth = rules.lineSame.pre.text.length;
  const empty = createPadding(prefixColumnWidth);
  if (wrapped) return [empty, empty];

  const gutterFor = (rule: Format.Rule): string => outputImpl.applyRule("", { rule, refined: false });

  switch (line.kind) {
    case "Same": {
      const unifiedLine = Line.anyNonSame(line.prev) || Line.anyNonSame(line.next);
      const gutter = unifiedLine ? gutterFor(rules.lineUnified) : gutterFor(rules.lineSame);
      return [gutter, gutter];
    }
    case "Prev": {
      const rule = line.moveId === undefined ? rules.linePrev : rules.movedFromPrev;
      return [gutterFor(rule), empty];
    }
    case "Next": {
      const rule = line.moveId === undefined ? rules.lineNext : rules.movedToNext;
      return [empty, gutterFor(rule)];
    }
  }
};

const getDiffStyle = (args: {
  readonly rules: Format.Rules;
  readonly outputImpl: OutputS;
  readonly line: LineInfo;
}): ((tag: Tag, s: string) => string) => {
  const { rules, outputImpl, line } = args;
  const apply = (rule: Format.Rule, str: string): string => outputImpl.applyRule(str, { rule, refined: false });
  const basic = (tag: Tag, s: string): string => {
    switch (tag) {
      case "Prev":
        return apply(rules.wordPrev, s);
      case "Same":
        return apply(rules.wordSameUnified, s);
      case "Next":
        return apply(rules.wordNext, s);
    }
  };
  if (
    line.kind === "Same" ||
    (line.kind === "Prev" && line.moveId === undefined) ||
    (line.kind === "Next" && line.moveId === undefined)
  ) {
    return basic;
  }
  if (line.kind === "Prev") {
    const sameRule = Format.Rule.stripPrefix(rules.movedFromPrev);
    return (tag, s) => {
      switch (tag) {
        case "Prev":
          return apply(rules.wordPrev, s);
        case "Same":
          return apply(sameRule, s);
        case "Next":
          return s;
      }
    };
  }
  // line.kind === "Next"
  const sameRule = Format.Rule.stripPrefix(rules.movedToNext);
  return (tag, s) => {
    switch (tag) {
      case "Prev":
        return s;
      case "Same":
        return apply(sameRule, s);
      case "Next":
        return apply(rules.wordNext, s);
    }
  };
};

const renderSideBySideLine = (args: {
  readonly lineNumWidth: number;
  readonly rules: Format.Rules;
  readonly output: Output;
  readonly outputImpl: OutputS;
  readonly wrapOrTruncate: WrapOrTruncate;
  readonly paneCols: number;
  readonly line: LineInfo;
}): readonly (readonly [string, string])[] => {
  const { lineNumWidth, rules, output, outputImpl, wrapOrTruncate, paneCols, line } = args;
  const prefixColumnWidth = rules.lineSame.pre.text.length;
  const width = lineNumWidth <= 0 ? paneCols - prefixColumnWidth : paneCols - prefixColumnWidth - lineNumWidth - 1;
  let pairs: readonly (readonly [Line, Line])[];
  switch (wrapOrTruncate) {
    case "wrap":
      pairs = LineInfo.wrap({ width }, line).map(LineInfo.lines);
      break;
    case "truncate": {
      const t = LineInfo.truncate({ width }, line);
      pairs = [LineInfo.lines(t)];
      break;
    }
    case "neither":
      pairs = [LineInfo.lines(line)];
      break;
  }
  const style = getDiffStyle({ rules, outputImpl, line });
  return pairs.map(([left, right], i) => {
    const [lnum, rnum] =
      lineNumWidth <= 0
        ? ["", ""]
        : [lineNumText(left.lineNumber, lineNumWidth), lineNumText(right.lineNumber, lineNumWidth)];
    const [lgut, rgut] = getGutters({
      wrapped: i > 0,
      rules,
      outputImpl,
      line,
    });
    const lpad = createPadding(Math.max(0, width - Line.width(left)));
    const ltext = Line.styledString(left, { output, style });
    const rtext = Line.styledString(right, { output, style });
    const leftStr = lnum + lgut + ltext + lpad;
    const rightStr = (rnum + rgut + rtext).replace(/\s+$/, "");
    return [leftStr, rightStr] as const;
  });
};

export type BuildArgs = {
  readonly widthOverride?: number;
  readonly includeLineNumbers?: boolean;
  readonly rules: Format.Rules;
  readonly wrapOrTruncate: WrapOrTruncate;
  readonly output: Output;
  readonly outputImpl: OutputS;
  readonly hunks: StructuredHunks;
  /** Computes the total side-by-side width given an optional [widthOverride].
   *  When absent, falls back to the OCaml [Error _] branch: [defaultDoubleColumnWidth]. */
  readonly computeWidth?: (widthOverride?: number) => number;
};

/** Build side-by-side rendered lines for each hunk. */
export const build = (args: BuildArgs): readonly (readonly (readonly [string, string])[])[] => {
  const includeLineNumbers = args.includeLineNumbers ?? true;
  const computeWidth = args.computeWidth ?? defaultComputeWidth;
  const totalWidth = computeWidth(args.widthOverride);
  // Reserve one character for the center divider.
  let paneCols = Math.floor((totalWidth - 1) / 2);
  paneCols = Math.max(paneCols, MIN_COL_WIDTH);
  const lineNumWidth = includeLineNumbers ? String(maxLineNumber(args.hunks)).length : 0;
  const out: (readonly [string, string])[][] = [];
  for (const hunkLines of hunksToLines(args.hunks)) {
    const block: (readonly [string, string])[] = [];
    for (const line of hunkLines) {
      const rendered = renderSideBySideLine({
        lineNumWidth,
        rules: args.rules,
        output: args.output,
        outputImpl: args.outputImpl,
        wrapOrTruncate: args.wrapOrTruncate,
        paneCols,
        line,
      });
      for (const pair of rendered) block.push(pair);
    }
    out.push(block);
  }
  return out;
};

const renderFilenames = (args: {
  readonly prevFile: FileName;
  readonly nextFile: FileName;
  readonly paneCols: number;
  readonly output: Output;
  readonly outputImpl: OutputS;
  readonly rules: Format.Rules;
  readonly lineNumWidth: number;
}): readonly string[] => {
  const { prevFile, nextFile, paneCols, output, outputImpl, rules, lineNumWidth } = args;
  const colsAvailable = paneCols - lineNumWidth;
  const lineNumSpace = " ".repeat(Math.max(0, lineNumWidth));
  const middleDivider = makeDivider(output);
  const renderFileName = (rule: Format.Rule, file: FileName): string => {
    const filename = FileNameMod.displayName(file);
    return outputImpl.applyRule("", { rule, refined: false }) + filename;
  };
  const prev = renderFileName(rules.linePrev, prevFile);
  const next = renderFileName(rules.lineNext, nextFile);
  if (output === "Ansi" || output === "Ascii") {
    return AnsiText.toDoubleColumn({
      width: Math.max(0, colsAvailable),
      left: prev,
      right: next,
    }).map(([left, right]) => lineNumSpace + left + middleDivider + lineNumSpace + right);
  }
  // Html: don't try to use ansi_text to wrap HTML
  const buffWidth = Math.max(0, paneCols - FileNameMod.displayName(prevFile).length);
  const buff = " ".repeat(buffWidth);
  return [lineNumSpace + prev + buff + middleDivider + lineNumSpace + next];
};

export type PrintArgs = {
  readonly widthOverride?: number;
  readonly fileNames?: readonly [FileName, FileName];
  readonly rules: Format.Rules;
  readonly wrapOrTruncate: WrapOrTruncate;
  readonly output: Output;
  readonly outputImpl: OutputS;
  readonly print: (s: string) => void;
  readonly hunks: StructuredHunks;
  readonly computeWidth?: (widthOverride?: number) => number;
};

export const print = (args: PrintArgs): void => {
  const computeWidth = args.computeWidth ?? defaultComputeWidth;
  const insertFilenames = (): void => {
    if (args.fileNames === undefined) return;
    const [prevFile, nextFile] = args.fileNames;
    const lineNumWidth = String(maxLineNumber(args.hunks)).length + 1;
    const totalWidth = computeWidth(args.widthOverride);
    const paneCols = Math.floor((totalWidth - 1) / 2);
    const filenameLines = renderFilenames({
      prevFile,
      nextFile,
      paneCols,
      output: args.output,
      outputImpl: args.outputImpl,
      rules: args.rules,
      lineNumWidth,
    });
    for (const ln of filenameLines) args.print(ln);
  };
  const middleDivider = makeDivider(args.output);
  if (args.output === "Html") {
    args.print('<pre style="font-family:consolas,monospace">');
  }
  insertFilenames();
  const blocks = build({
    ...(args.widthOverride !== undefined ? { widthOverride: args.widthOverride } : {}),
    rules: args.rules,
    wrapOrTruncate: args.wrapOrTruncate,
    output: args.output,
    outputImpl: args.outputImpl,
    hunks: args.hunks,
    computeWidth,
  });
  for (const block of blocks) {
    for (const [left, right] of block) {
      args.print(left + middleDivider + right);
    }
  }
  if (args.output === "Html") {
    args.print("</pre>");
  }
};

export type OutputToStringArgs = {
  readonly widthOverride?: number;
  readonly fileNames: readonly [FileName, FileName];
  readonly rules: Format.Rules;
  readonly wrapOrTruncate: WrapOrTruncate;
  readonly output: Output;
  readonly outputImpl: OutputS;
  readonly hunks: StructuredHunks;
  readonly computeWidth?: (widthOverride?: number) => number;
};

export const outputToString = (args: OutputToStringArgs): string => {
  const computeWidth = args.computeWidth ?? defaultComputeWidth;
  const [prevFile, nextFile] = args.fileNames;
  const lineNumWidth = String(maxLineNumber(args.hunks)).length + 1;
  const totalWidth = computeWidth(args.widthOverride);
  const paneCols = Math.floor((totalWidth - 1) / 2);
  const filenameLines = renderFilenames({
    prevFile,
    nextFile,
    paneCols,
    output: args.output,
    outputImpl: args.outputImpl,
    rules: args.rules,
    lineNumWidth,
  });
  const blocks = build({
    ...(args.widthOverride !== undefined ? { widthOverride: args.widthOverride } : {}),
    rules: args.rules,
    wrapOrTruncate: args.wrapOrTruncate,
    output: args.output,
    outputImpl: args.outputImpl,
    hunks: args.hunks,
    computeWidth,
  });
  const middleDivider = makeDivider(args.output);
  const bodyLines: string[] = [];
  for (const block of blocks) {
    for (const [left, right] of block) {
      bodyLines.push(left + middleDivider + right);
    }
  }
  return [...filenameLines, ...bodyLines].join("\n");
};

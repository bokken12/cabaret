import type { Hunk } from "../patience-diff/hunk.js";
import { Hunks } from "../patience-diff/hunks.js";
import { Range } from "../patience-diff/range.js";
import { Percent } from "../shared/percent.js";

export type StringWithFloats = {
  readonly floats: readonly number[];
  readonly withoutFloats: string;
};

// Mirrors the OCaml `Re` regex. Matches a delimiter or boundary, then a float,
// then a delimiter, end-of-string, '%', or a unit (bp|s|m|ms) followed by a
// word boundary.
const DELIM = ` ;:,\\|#&(){}[\\]<>~=+\\-*/`;
// Group 1: prefix; Group 2: float; Group 3: suffix.
const FLOAT_REGEX = new RegExp(
  `(^|\\$|[${DELIM}])` + `(-?\\d+(?:\\.\\d*)?(?:[eE][+-]?\\d+)?)` + `(?:(?=$|%|[${DELIM}])|(?:(?:bp|ms|s|m)\\b))`,
);

const findFloat = (s: string): { match: RegExpExecArray; suffixLen: number } | undefined => {
  const m = FLOAT_REGEX.exec(s);
  if (m === null) return undefined;
  const matchEnd = m.index + m[0].length;
  const prefix = m[1] ?? "";
  const float = m[2] ?? "";
  const suffixLen = m[0].length - prefix.length - float.length;
  // Validate that what we matched is parseable.
  if (Number.isNaN(Number(float))) return undefined;
  void matchEnd;
  return { match: m, suffixLen };
};

export const createStringWithFloats = (s: string): StringWithFloats => {
  const floats: number[] = [];
  let line = s;
  while (true) {
    const found = findFloat(line);
    if (found === undefined) {
      return { floats, withoutFloats: line };
    }
    const { match, suffixLen } = found;
    const prefix = match[1] ?? "";
    const float = match[2] ?? "";
    floats.push(Number(float));
    const start = match.index;
    const end = start + match[0].length;
    // Replace match by `prefix + suffix` (suffix is the trailing matched chars
    // after the float, which is either zero-width or a unit like "bp").
    const suffix = match[0].slice(prefix.length + float.length, prefix.length + float.length + suffixLen);
    line = line.slice(0, start) + prefix + suffix + line.slice(end);
  }
};

export const closeEnough = (tolerance: Percent): ((a: StringWithFloats, b: StringWithFloats) => boolean) => {
  const tol = Percent.toMult(tolerance);
  const floatsEqual = (f: number, fp: number): boolean => {
    const baseline = Math.min(Math.abs(f), Math.abs(fp));
    return Math.abs(f - fp) <= tol * baseline;
  };
  return (a, b) => {
    if (a.withoutFloats !== b.withoutFloats) return false;
    if (a.floats.length !== b.floats.length) return false;
    for (let i = 0; i < a.floats.length; i++) {
      if (!floatsEqual(a.floats[i]!, b.floats[i]!)) return false;
    }
    return true;
  };
};

// Needleman-Wunsch returning a[i][j] = Levenshtein dist of xs[:i] vs ys[:j].
const needlemanWunsch = <T>(xs: readonly T[], ys: readonly T[], equal: (a: T, b: T) => boolean): number[][] => {
  const rows = xs.length;
  const cols = ys.length;
  const a: number[][] = [];
  for (let i = 0; i <= rows; i++) {
    a.push(new Array<number>(cols + 1).fill(Number.MAX_SAFE_INTEGER));
  }
  for (let i = 0; i <= rows; i++) a[i]![0] = i;
  for (let j = 0; j <= cols; j++) a[0]![j] = j;
  for (let i = 1; i <= rows; i++) {
    for (let j = 1; j <= cols; j++) {
      const c = equal(xs[i - 1]!, ys[j - 1]!) ? 0 : 1;
      a[i]![j] = Math.min(a[i - 1]![j]! + 1, a[i]![j - 1]! + 1, a[i - 1]![j - 1]! + c);
    }
  }
  return a;
};

type PartialRangeIndexes =
  | { kind: "matching"; pairs: readonly (readonly [number, number])[] }
  | { kind: "nonmatching"; is: readonly number[]; js: readonly number[] };

const smallest = (a: number, b: number, c: number): number => {
  if (a < b) return a < c ? 0 : 2;
  return b < c ? 1 : 2;
};

const consMinusOne = (car: number, cdr: readonly number[], ifUnequalTo: number): readonly number[] => {
  if (car === ifUnequalTo) return cdr;
  return [car - 1, ...cdr];
};

const recoverRanges = (xs: readonly string[], ys: readonly string[], a: number[][]): Range<string>[] => {
  let acc: PartialRangeIndexes[] = [];
  let i = xs.length;
  let j = ys.length;
  while (true) {
    if (i <= 0 || j <= 0) {
      if (i <= 0 && j <= 0) break;
      const is_: number[] = [];
      for (let k = 0; k < i; k++) is_.push(k);
      const js_: number[] = [];
      for (let k = 0; k < j; k++) js_.push(k);
      const head = acc[0];
      if (head === undefined || head.kind === "matching") {
        acc = [{ kind: "nonmatching", is: is_, js: js_ }, ...acc];
      } else {
        acc = [{ kind: "nonmatching", is: [...is_, ...head.is], js: [...js_, ...head.js] }, ...acc.slice(1)];
      }
      break;
    }
    const which = smallest(a[i - 1]![j]!, a[i - 1]![j - 1]!, a[i]![j - 1]!);
    let iNew: number;
    let jNew: number;
    let matched: boolean;
    switch (which) {
      case 0:
        iNew = i - 1;
        jNew = j;
        matched = false;
        break;
      case 1:
        iNew = i - 1;
        jNew = j - 1;
        matched = a[i]![j] === a[i - 1]![j - 1];
        break;
      case 2:
        iNew = i;
        jNew = j - 1;
        matched = false;
        break;
      default:
        throw new Error("unreachable");
    }
    if (matched) {
      const head = acc[0];
      if (head === undefined || head.kind === "nonmatching") {
        acc = [{ kind: "matching", pairs: [[i - 1, j - 1]] }, ...acc];
      } else {
        acc = [{ kind: "matching", pairs: [[i - 1, j - 1], ...head.pairs] }, ...acc.slice(1)];
      }
    } else {
      const head = acc[0];
      if (head === undefined || head.kind === "matching") {
        acc = [
          {
            kind: "nonmatching",
            is: consMinusOne(i, [], iNew),
            js: consMinusOne(j, [], jNew),
          },
          ...acc,
        ];
      } else {
        acc = [
          {
            kind: "nonmatching",
            is: consMinusOne(i, head.is, iNew),
            js: consMinusOne(j, head.js, jNew),
          },
          ...acc.slice(1),
        ];
      }
    }
    i = iNew;
    j = jNew;
  }
  const eltsOfIndices = (is: readonly number[], src: readonly string[]): readonly string[] => is.map((k) => src[k]!);
  return acc.map((part): Range<string> => {
    if (part.kind === "matching") {
      const pairs = part.pairs.map(([ii, jj]) => [xs[ii]!, ys[jj]!] as const);
      return Range.same(pairs);
    }
    if (part.is.length > 0 && part.js.length === 0) {
      return Range.prev(eltsOfIndices(part.is, xs));
    }
    if (part.is.length === 0 && part.js.length > 0) {
      return Range.next(eltsOfIndices(part.js, ys));
    }
    return Range.replace(eltsOfIndices(part.is, xs), eltsOfIndices(part.js, ys));
  });
};

const doTolerance = (
  hunks: readonly Hunk<string>[],
  equal: (a: StringWithFloats, b: StringWithFloats) => boolean,
): readonly Hunk<string>[] =>
  Hunks.concatMapRanges(hunks, (range): Range<string>[] => {
    switch (range.kind) {
      case "same":
      case "prev":
      case "next":
        return [range];
      case "unified":
        throw new Error(`Unexpected Unified range`);
      case "replace": {
        const prevSwf = range.prev.map(createStringWithFloats);
        const nextSwf = range.next.map(createStringWithFloats);
        const a = needlemanWunsch(prevSwf, nextSwf, equal);
        return recoverRanges(range.prev, range.next, a);
      }
    }
  });

// --- Context_limit ---

type Position = "Start" | "Middle" | "End";
type RangeWithPosition = { range: Range<string>; pos: Position };

const mergedWithPosition = (ranges: readonly Range<string>[]): RangeWithPosition[] => {
  if (ranges.length === 0) return [];
  const out: RangeWithPosition[] = [];
  let car = ranges[0]!;
  let pos: Position = "Start";
  const consume = (cadr: Range<string>): void => {
    if (car.kind === "unified" || cadr.kind === "unified") {
      throw new Error("Unexpected unified range");
    }
    if (car.kind === "same" && cadr.kind === "same") {
      car = Range.same([...car.contents, ...cadr.contents]);
    } else {
      out.push({ range: car, pos });
      car = cadr;
      pos = "Middle";
    }
  };
  for (let i = 1; i < ranges.length; i++) consume(ranges[i]!);
  // inner_finished
  if (car.kind === "unified") {
    throw new Error("Unexpected unified range");
  }
  if (car.kind === "same" && pos === "Start") {
    return out;
  }
  out.push({ range: car, pos: "End" });
  return out;
};

type DropOrKeep = { kind: "drop"; n: number } | { kind: "keep"; range: Range<string> };

const dropFromStart = (context: number, lines: readonly (readonly [string, string])[]): DropOrKeep[] => {
  const extra = lines.length - context;
  if (extra <= 0) return [{ kind: "keep", range: Range.same(lines) }];
  return [
    { kind: "drop", n: extra },
    { kind: "keep", range: Range.same(lines.slice(extra, extra + context)) },
  ];
};

const dropFromEnd = (context: number, lines: readonly (readonly [string, string])[]): DropOrKeep[] => {
  const extra = lines.length - context;
  if (extra <= 0) return [{ kind: "keep", range: Range.same(lines) }];
  return [{ kind: "keep", range: Range.same(lines.slice(0, context)) }];
};

const dropFromMiddle = (context: number, lines: readonly (readonly [string, string])[]): DropOrKeep[] => {
  const extra = lines.length - 2 * context;
  if (extra <= 0) return [{ kind: "keep", range: Range.same(lines) }];
  const start = lines.length - context;
  return [
    { kind: "keep", range: Range.same(lines.slice(0, context)) },
    { kind: "drop", n: extra },
    { kind: "keep", range: Range.same(lines.slice(start, start + context)) },
  ];
};

const dropOrKeep = (context: number, rwps: readonly RangeWithPosition[]): DropOrKeep[] => {
  const out: DropOrKeep[] = [];
  for (const { range, pos } of rwps) {
    if (range.kind === "unified") {
      throw new Error("Unexpected Unified range");
    }
    if (range.kind !== "same") {
      out.push({ kind: "keep", range });
      continue;
    }
    const lines = range.contents;
    switch (pos) {
      case "Start":
        out.push(...dropFromStart(context, lines));
        break;
      case "End":
        out.push(...dropFromEnd(context, lines));
        break;
      case "Middle":
        out.push(...dropFromMiddle(context, lines));
        break;
    }
  }
  return out;
};

const reconstructHunks = (args: {
  prevStart: number;
  nextStart: number;
  dropOrKeeps: readonly DropOrKeep[];
}): Hunk<string>[] => {
  type State = {
    prevStart: number;
    nextStart: number;
    rangesRev: Range<string>[];
  };
  const toHunk = (s: State): Hunk<string> => {
    const ranges = s.rangesRev.slice().reverse();
    return {
      prevStart: s.prevStart,
      prevSize: ranges.reduce((a, r) => a + Range.prevSize(r), 0),
      nextStart: s.nextStart,
      nextSize: ranges.reduce((a, r) => a + Range.nextSize(r), 0),
      ranges,
    };
  };
  const out: Hunk<string>[] = [];
  let state: State = {
    prevStart: args.prevStart,
    nextStart: args.nextStart,
    rangesRev: [],
  };
  for (const dk of args.dropOrKeeps) {
    if (dk.kind === "keep") {
      state.rangesRev.unshift(dk.range);
    } else {
      const hunk = toHunk(state);
      const newState: State = {
        prevStart: state.prevStart + hunk.prevSize + dk.n,
        nextStart: state.nextStart + hunk.nextSize + dk.n,
        rangesRev: [],
      };
      if (hunk.ranges.length !== 0) {
        out.push(hunk);
      }
      state = newState;
    }
  }
  if (state.rangesRev.length > 0) {
    out.push(toHunk(state));
  }
  return out;
};

const enforce = (context: number, hunk: Hunk<string>): Hunk<string>[] => {
  const rwps = mergedWithPosition(hunk.ranges);
  const dks = dropOrKeep(context, rwps);
  return reconstructHunks({
    prevStart: hunk.prevStart,
    nextStart: hunk.nextStart,
    dropOrKeeps: dks,
  });
};

export const apply = (hunks: readonly Hunk<string>[], tolerance: Percent, context: number): readonly Hunk<string>[] => {
  const eq = closeEnough(tolerance);
  const toler = doTolerance(hunks, eq);
  return toler.flatMap((h) => enforce(context, h));
};

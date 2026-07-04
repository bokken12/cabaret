/**
 * A string that doesn't contain ANSI codes, but may contain unicode chars.
 * Tracks per-codepoint widths to support [split] correctly.
 */

interface CharInfo {
  readonly str: string;
  readonly width: number;
}

export interface T {
  readonly str: string;
  readonly charInfos: readonly CharInfo[];
  readonly width: number;
}

const isInRanges = (cp: number, ranges: readonly [number, number][]): boolean => {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid]!;
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
};

// East Asian Wide and Fullwidth ranges that produce width 2 in typical TTYs.
// Sorted by start; covers the bulk of CJK + emoji ranges used in practice.
const wideRanges: readonly [number, number][] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f1e6, 0x1f1ff],
  [0x1f200, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d7],
  [0x1f6dc, 0x1f6df],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb],
  [0x1f7f0, 0x1f7f0],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1fa7c],
  [0x1fa80, 0x1fa88],
  [0x1fa90, 0x1fabd],
  [0x1fabf, 0x1fac5],
  [0x1face, 0x1fadb],
  [0x1fae0, 0x1fae8],
  [0x1faf0, 0x1faf8],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

// Zero-width: combining marks, ZWJ, etc. Minimal coverage.
const zeroWidthRanges: readonly [number, number][] = [
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x05bf, 0x05bf],
  [0x05c1, 0x05c2],
  [0x05c4, 0x05c5],
  [0x05c7, 0x05c7],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x06df, 0x06e4],
  [0x06e7, 0x06e8],
  [0x06ea, 0x06ed],
  [0x0711, 0x0711],
  [0x0730, 0x074a],
  [0x07a6, 0x07b0],
  [0x07eb, 0x07f3],
  [0x07fd, 0x07fd],
  [0x0816, 0x0819],
  [0x081b, 0x0823],
  [0x0825, 0x0827],
  [0x0829, 0x082d],
  [0x0859, 0x085b],
  [0x08d3, 0x08e1],
  [0x08e3, 0x0902],
  [0x093a, 0x093a],
  [0x093c, 0x093c],
  [0x0941, 0x0948],
  [0x094d, 0x094d],
  [0x0951, 0x0957],
  [0x0962, 0x0963],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xe0100, 0xe01ef],
];

const codepointWidth = (cp: number): number => {
  // Approximation of Uucp.Break.tty_width_hint:
  // - C0/C1 controls return -1 (we clamp to 0 via max 0)
  // - zero-width combining marks return 0
  // - East Asian Wide/Fullwidth return 2
  // - everything else returns 1
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (isInRanges(cp, zeroWidthRanges)) return 0;
  if (isInRanges(cp, wideRanges)) return 2;
  return 1;
};

const codepointsOf = (s: string): CharInfo[] => {
  const result: CharInfo[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    result.push({ str: ch, width: Math.max(0, codepointWidth(cp)) });
  }
  return result;
};

export const ofString = (str: string): T => {
  const charInfos = codepointsOf(str);
  let width = 0;
  for (const ci of charInfos) width += ci.width;
  return { str, charInfos, width };
};

export const width = (t: T): number => t.width;
export const isEmpty = (t: T): boolean => t.str.length === 0;
export const toString = (t: T): string => t.str;

export const split = (t: T, pos: number): readonly [T, T] => {
  let widthSoFar = 0;
  let n = 0;
  for (let i = 0; i < t.charInfos.length; i++) {
    const w = t.charInfos[i]!.width;
    if (widthSoFar + w > pos) break;
    widthSoFar += w;
    n = i + 1;
  }
  const prefixInfos = t.charInfos.slice(0, n);
  const suffixInfos = t.charInfos.slice(n);
  let prefixStr = "";
  for (const ci of prefixInfos) prefixStr += ci.str;
  const suffixStr = t.str.slice(prefixStr.length);
  const prefix: T = {
    str: prefixStr,
    charInfos: prefixInfos,
    width: widthSoFar,
  };
  const suffix: T = {
    str: suffixStr,
    charInfos: suffixInfos,
    width: t.width - widthSoFar,
  };
  return [prefix, suffix];
};

export const concat2 = (t1: T, t2: T): T => ({
  str: t1.str + t2.str,
  charInfos: [...t1.charInfos, ...t2.charInfos],
  width: t1.width + t2.width,
});

export const concat = (ts: readonly T[]): T => {
  const empty: T = { str: "", charInfos: [], width: 0 };
  let acc = empty;
  for (const t of ts) acc = concat2(acc, t);
  return acc;
};

export const equal = (a: T, b: T): boolean => a.str === b.str;

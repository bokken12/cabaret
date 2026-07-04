/** Scoring functions for choosing diff boundaries. Mirrors OCaml's [score_line]. */

export type Side = "left" | "right";

/** Returns [(visualIndentation, indexAfterIndentation)] for [line], counting tabs as 4
 *  spaces, matching OCaml. */
export const indentation = (line: string): readonly [number, number] => {
  let n = 0;
  let i = 0;
  const len = line.length;
  while (i < len) {
    const ch = line[i]!;
    if (ch === " ") {
      n += 1;
      i += 1;
    } else if (ch === "\t") {
      n += 4;
      i += 1;
    } else {
      break;
    }
  }
  return [n, i];
};

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

const isSubstringAt = (line: string, pos: number, substring: string): boolean => line.startsWith(substring, pos);

/** Heuristic score for the quality of a diff boundary, mirroring OCaml [score_line]. */
export const scoreLine = (side: Side, line1: string, line2: string): number => {
  const [i1, startOf1] = indentation(line1);
  const [i2, startOf2] = indentation(line2);
  const someLinesAreBlank = line1.length === 0 || line2.length === 0;
  const baseScore = (() => {
    const i2Adj = someLinesAreBlank ? Math.max(i1, i2) : i2;
    return Math.max(-90, 90 - i2Adj * 2);
  })();
  const decreasingIndentationBonus = someLinesAreBlank
    ? 0
    : clamp(i1 === i2 ? (side === "left" ? 1 : 0) : i1 - i2, -2, 3);
  // bonus(n, line, sides, str): adds [n] if [str] is the prefix at the start of
  // [`above] (line1) or [`below] (line2), and [sides] matches the current side.
  type Above = "above" | "below";
  type Sides = "any" | "left" | "right";
  const bonus = (n: number, line: Above, sides: Sides, str: string): number => {
    const [target, pos] = line === "above" ? [line1, startOf1] : [line2, startOf2];
    const sidesMatches =
      sides === "any" || (sides === "left" && side === "left") || (sides === "right" && side === "right");
    if (!sidesMatches) return 0;
    return isSubstringAt(target, pos, str) ? n : 0;
  };

  let bonusForChars = 0;
  bonusForChars += bonus(1, "below", "any", "(("); // start of record bonus
  bonusForChars += bonus(3, "below", "any", "(");
  bonusForChars += bonus(1, "above", "right", "}");
  bonusForChars += bonus(-1, "below", "any", "}");
  bonusForChars += bonus(1, "below", "any", "{");
  // XML
  bonusForChars += bonus(5, "above", "any", "</");
  bonusForChars += bonus(-4, "below", "left", "</");
  bonusForChars += bonus(3, "below", "any", "<");
  bonusForChars += bonus(2, "below", "any", "*"); // heading
  bonusForChars += bonus(1, "below", "any", "-"); // bullet
  bonusForChars += bonus(3, "above", "right", ";;");
  bonusForChars += bonus(1, "above", "left", ";;");
  bonusForChars += bonus(4, "below", "left", "let");
  bonusForChars += bonus(-1, "below", "left", "let%");
  bonusForChars += bonus(2, "below", "left", "let%test");
  bonusForChars += bonus(2, "below", "left", "let%expect");
  bonusForChars += bonus(2, "below", "right", "let");
  bonusForChars += bonus(1, "above", "any", "in");
  bonusForChars += bonus(4, "below", "left", "module");
  bonusForChars += bonus(3, "above", "right", "end");
  bonusForChars += bonus(Math.min(-1, -decreasingIndentationBonus), "below", "any", ";;");
  bonusForChars += bonus(Math.min(-1, -decreasingIndentationBonus), "below", "any", "end");
  // starting on a blank line gives bonus
  if (startOf2 >= line2.length) bonusForChars += 2;

  return baseScore + decreasingIndentationBonus + bonusForChars;
};

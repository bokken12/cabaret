/** Top-level diff entry point. Mirrors OCaml's [diff]. */

import * as PatienceDiff from "../../patience-diff/patience-diff.js";
import type { Hunks } from "../hunks.js";
import { findMoves } from "./find-moves.js";
import { scoreLine } from "./score.js";
import { removeWs } from "./word-split.js";

export type DiffArgs = {
  readonly context: number;
  readonly lineBigEnough: number;
  readonly keepWs: boolean;
  readonly findMoves: boolean;
  readonly prev: readonly string[];
  readonly next: readonly string[];
};

const identity = <T>(x: T): T => x;

export const diff = (args: DiffArgs): Hunks => {
  const transform = args.keepWs ? identity : removeWs;
  const hunks = PatienceDiff.String.getHunks<string>({
    transform,
    context: args.context,
    bigEnough: args.lineBigEnough,
    maxSlide: 100,
    score: scoreLine,
    prev: args.prev,
    next: args.next,
  });
  return args.findMoves ? findMoves({ lineBigEnough: args.lineBigEnough, keepWs: args.keepWs, hunks }) : hunks;
};

/** Identifiers for the ways a 4-way hunk can be displayed, ported from Iron's
 *  [patdiff4/lib/diff_algo_id.ml]. */

import type * as Diamond from "./diamond.js";

export type DiffAlgoId =
  | "old_base_to_old_tip"
  | "old_base_to_new_base"
  | "old_base_to_new_tip"
  | "old_tip_to_new_tip"
  | "new_base_to_new_tip"
  | "feature_ddiff"
  | "base_ddiff"
  | "story"
  | "conflict_resolution";

export const isSimpleDiff = (t: DiffAlgoId): boolean => {
  switch (t) {
    case "old_base_to_old_tip":
    case "old_base_to_new_base":
    case "old_base_to_new_tip":
    case "old_tip_to_new_tip":
    case "new_base_to_new_tip":
      return true;
    case "feature_ddiff":
    case "base_ddiff":
    case "story":
    case "conflict_resolution":
      return false;
  }
};

export const simpleDiff = (from: Diamond.Node, to: Diamond.Node): DiffAlgoId => {
  if (from === "b1" && to === "f1") return "old_base_to_old_tip";
  if (from === "b1" && to === "b2") return "old_base_to_new_base";
  if (from === "b1" && to === "f2") return "old_base_to_new_tip";
  if (from === "f1" && to === "f2") return "old_tip_to_new_tip";
  if (from === "b2" && to === "f2") return "new_base_to_new_tip";
  throw new Error(`invalid diff: ${from} -> ${to}`);
};

export const toString = (t: DiffAlgoId): string => t.replace(/_/g, "-");

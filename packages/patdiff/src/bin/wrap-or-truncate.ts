/** Tiny enum/parser for the [-side-by-side] flag value.
 *  Translation of OCaml's [Patdiff_bin.Wrap_or_truncate]. */

export type T = "wrap" | "truncate";

export const all: readonly T[] = ["wrap", "truncate"];

export const toString = (t: T): string => t;

export const ofStringExn = (s: string): T => {
  const v = s.toLowerCase();
  if (v === "wrap" || v === "truncate") return v;
  throw new Error(`Invalid side-by-side mode: ${s} (expected wrap|truncate)`);
};

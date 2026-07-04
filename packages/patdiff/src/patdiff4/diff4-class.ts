/** Equivalence classes over the four versions around a rebase, ported from
 *  Iron's [common/diff4_class.ml].
 *
 *  b1 = old base, b2 = new base, f1 = old tip, f2 = new tip. Time moves
 *  bottom-to-top:
 *
 *  ```
 *       F2
 *       / \
 *      /   \
 *     F1    B2
 *      \   /
 *       \ /
 *        B1
 *  ```
 *
 *  A class names which of the four versions are equal; it decides both what a
 *  reviewer still needs to see and how to display it. */

export type Node = "b1" | "b2" | "f1" | "f2";

export type Diff4Class =
  | "b1_b2_f1_f2"
  | "b1_b2_f1"
  | "b1_b2_f2"
  | "b1_b2__f1_f2"
  | "b1_b2"
  | "b1_f1_f2"
  | "b1_f1__b2_f2"
  | "b1_f1"
  | "b1_f2__b2_f1"
  | "b1_f2"
  | "b2_f1_f2"
  | "b2_f1"
  | "b2_f2"
  | "f1_f2"
  | "conflict";

export const all: readonly Diff4Class[] = [
  "b1_b2_f1_f2",
  "b1_b2_f1",
  "b1_b2_f2",
  "b1_b2__f1_f2",
  "b1_b2",
  "b1_f1_f2",
  "b1_f1__b2_f2",
  "b1_f1",
  "b1_f2__b2_f1",
  "b1_f2",
  "b2_f1_f2",
  "b2_f1",
  "b2_f2",
  "f1_f2",
  "conflict",
];

/** The classes with something left to show a reviewer. The complement —
 *  no change, clean merges, and the base absorbing the same change — renders
 *  nothing. */
export type ShownClass = Exclude<Diff4Class, "b1_b2_f1_f2" | "b1_b2__f1_f2" | "b1_f1__b2_f2" | "b2_f1_f2">;

export const shownClassOf = (t: Diff4Class): ShownClass | undefined => {
  switch (t) {
    case "b1_b2_f1_f2":
    case "b1_b2__f1_f2":
    case "b1_f1__b2_f2":
    case "b2_f1_f2":
      return undefined;
    default:
      return t;
  }
};

export const isShown = (t: Diff4Class): boolean => shownClassOf(t) !== undefined;

export const classify = <A>(args: { equal: (a: A, b: A) => boolean; b1: A; b2: A; f1: A; f2: A }): Diff4Class => {
  const { equal: eq, b1, b2, f1, f2 } = args;
  if (eq(b1, b2)) {
    if (eq(b2, f1)) return eq(f1, f2) ? "b1_b2_f1_f2" : "b1_b2_f1";
    if (eq(b2, f2)) return "b1_b2_f2";
    return eq(f1, f2) ? "b1_b2__f1_f2" : "b1_b2";
  }
  if (eq(b1, f1)) {
    if (eq(f1, f2)) return "b1_f1_f2";
    return eq(b2, f2) ? "b1_f1__b2_f2" : "b1_f1";
  }
  if (eq(b1, f2)) return eq(b2, f1) ? "b1_f2__b2_f1" : "b1_f2";
  if (eq(b2, f1)) return eq(f1, f2) ? "b2_f1_f2" : "b2_f1";
  if (eq(b2, f2)) return "b2_f2";
  if (eq(f1, f2)) return "f1_f2";
  return "conflict";
};

export const toGroups = (t: Diff4Class): readonly (readonly Node[])[] => {
  switch (t) {
    case "b1_b2_f1_f2":
      return [["b1", "b2", "f1", "f2"]];
    case "b1_b2_f1":
      return [["b1", "b2", "f1"], ["f2"]];
    case "b1_b2_f2":
      return [["b1", "b2", "f2"], ["f1"]];
    case "b1_b2__f1_f2":
      return [
        ["b1", "b2"],
        ["f1", "f2"],
      ];
    case "b1_b2":
      return [["b1", "b2"], ["f1"], ["f2"]];
    case "b1_f1_f2":
      return [["b1", "f1", "f2"], ["b2"]];
    case "b1_f1__b2_f2":
      return [
        ["b1", "f1"],
        ["b2", "f2"],
      ];
    case "b1_f1":
      return [["b1", "f1"], ["b2"], ["f2"]];
    case "b1_f2__b2_f1":
      return [
        ["b1", "f2"],
        ["b2", "f1"],
      ];
    case "b1_f2":
      return [["b1", "f2"], ["f1"], ["b2"]];
    case "b2_f1_f2":
      return [["b1"], ["b2", "f1", "f2"]];
    case "b2_f1":
      return [["b1"], ["b2", "f1"], ["f2"]];
    case "b2_f2":
      return [["b1"], ["f1"], ["b2", "f2"]];
    case "f1_f2":
      return [["b1"], ["f1", "f2"], ["b2"]];
    case "conflict":
      return [["b1"], ["b2"], ["f1"], ["f2"]];
  }
};

/** Human form of the non-trivial equivalence sets, e.g. `"{ B1 F2 } { B2 F1 }"`. */
export const toString = (t: Diff4Class): string => {
  const groups = toGroups(t)
    .filter((group) => group.length > 1)
    .map((group) => `{ ${group.map((node) => node.toUpperCase()).join(" ")} }`);
  return groups.length === 0 ? "{ }" : groups.join(" ");
};

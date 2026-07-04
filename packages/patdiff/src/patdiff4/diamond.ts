/** The four versions of a file around a rebase, ported from Iron's
 *  [common/diamond.ml]. See [diff4-class.ts] for the geometry. */

import * as Diff4Class from "./diff4-class.js";

export type Diamond<A> = {
  readonly b1: A;
  readonly f1: A;
  readonly b2: A;
  readonly f2: A;
};

export type Node = Diff4Class.Node;

export const nodes: readonly Node[] = ["b1", "b2", "f1", "f2"];

export const singleton = <A>(a: A): Diamond<A> => ({ b1: a, f1: a, b2: a, f2: a });

export const init = <A>(f: (node: Node) => A): Diamond<A> => ({
  b1: f("b1"),
  f1: f("f1"),
  b2: f("b2"),
  f2: f("f2"),
});

export const get = <A>(t: Diamond<A>, node: Node): A => t[node];

export const map = <A, B>(t: Diamond<A>, f: (a: A) => B): Diamond<B> => ({
  b1: f(t.b1),
  f1: f(t.f1),
  b2: f(t.b2),
  f2: f(t.f2),
});

export const map2 = <A, B, C>(a: Diamond<A>, b: Diamond<B>, f: (a: A, b: B) => C): Diamond<C> => ({
  b1: f(a.b1, b.b1),
  f1: f(a.f1, b.f1),
  b2: f(a.b2, b.b2),
  f2: f(a.f2, b.f2),
});

export const map3 = <A, B, C, D>(
  a: Diamond<A>,
  b: Diamond<B>,
  c: Diamond<C>,
  f: (a: A, b: B, c: C) => D,
): Diamond<D> => ({
  b1: f(a.b1, b.b1, c.b1),
  f1: f(a.f1, b.f1, c.f1),
  b2: f(a.b2, b.b2, c.b2),
  f2: f(a.f2, b.f2, c.f2),
});

export const forAll = <A>(t: Diamond<A>, f: (a: A) => boolean): boolean => f(t.b1) && f(t.b2) && f(t.f1) && f(t.f2);

export const forAll2 = <A, B>(a: Diamond<A>, b: Diamond<B>, f: (a: A, b: B) => boolean): boolean =>
  f(a.b1, b.b1) && f(a.b2, b.b2) && f(a.f1, b.f1) && f(a.f2, b.f2);

export const classify = <A>(equal: (a: A, b: A) => boolean, t: Diamond<A>): Diff4Class.Diff4Class =>
  Diff4Class.classify({ equal, b1: t.b1, b2: t.b2, f1: t.f1, f2: t.f2 });

/** At each node, the values of every node equivalent to it under `by`. */
export const group = <A>(t: Diamond<A>, by: Diff4Class.Diff4Class): Diamond<readonly A[]> => {
  const result: { [K in Node]?: readonly A[] } = {};
  for (const nodeGroup of Diff4Class.toGroups(by)) {
    const contents = nodeGroup.map((node) => get(t, node));
    for (const node of nodeGroup) {
      result[node] = contents;
    }
  }
  return init((node) => {
    const contents = result[node];
    if (contents === undefined) {
      throw new Error(`diff4 class groups missed node ${node}`);
    }
    return contents;
  });
};

/** Short display names for the four revisions, collapsing equal ones (e.g.
 *  "base" when both bases coincide). */
export const prettyShortRevNames = <A>(equal: (a: A, b: A) => boolean, t: Diamond<A>): Diamond<string> => {
  const { b1, b2, f1, f2 } = t;
  const sameBs = equal(b1, b2);
  const sameFs = equal(f1, f2);
  if (sameFs && equal(b2, f1)) {
    if (sameBs) {
      return singleton("base");
    }
    // This is a forget: the tip rejoined the base.
    return { b1: "old base", b2: "old tip", f1: "old tip", f2: "old tip" };
  }
  return {
    b1: sameBs ? "base" : "old base",
    b2: sameBs ? "base" : "new base",
    f1: sameBs && equal(b1, f1) ? "base" : sameFs ? "tip" : "old tip",
    f2: sameBs && equal(b1, f1) ? "tip" : sameFs ? "tip" : "new tip",
  };
};

export const prettyShortRevNamesConst: Diamond<string> = {
  b1: "old base",
  b2: "new base",
  f1: "old tip",
  f2: "new tip",
};

/** Labeled values for the distinct revisions, collapsing equal ones. */
export const prettyShortDescription = (args: {
  label: string;
  diamond: Diamond<string>;
}): readonly [string, string][] => {
  const { b1, b2, f1, f2 } = args.diamond;
  const label = (s: string): string => {
    if (s === "") return args.label;
    if (args.label === "") return s;
    return `${s} ${args.label}`;
  };
  const sameBs = b1 === b2;
  const sameFs = f1 === f2;
  if (sameFs && b2 === f1) {
    if (sameBs) return [[label(""), b1]];
    return [
      [label("old base"), b1],
      [label("old tip"), f1],
    ];
  }
  if (sameBs && sameFs) {
    if (b1 === f1) return [[label(""), b1]];
    return [
      [label("base"), b1],
      [label("tip"), f1],
    ];
  }
  if (sameBs) {
    if (b1 === f1) {
      return [
        [label("base"), b1],
        [label("tip"), f2],
      ];
    }
    return [
      [label("base"), b1],
      [label("old tip"), f1],
      [label("new tip"), f2],
    ];
  }
  if (sameFs) {
    return [
      [label("old base"), b1],
      [label("new base"), b2],
      [label("old & new tip"), f2],
    ];
  }
  return [
    [label("old base"), b1],
    [label("old tip"), f1],
    [label("new base"), b2],
    [label("new tip"), f2],
  ];
};

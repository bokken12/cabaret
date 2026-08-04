import { expect, test } from "vitest";
import { Variant } from "../src/index.ts";

const match = Variant.match;

type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "square"; side: number }
  | { kind: "line"; length: number };

const shapes: Shape[] = [
  { kind: "circle", radius: 7 },
  { kind: "square", side: 3 },
  { kind: "line", length: 5 },
];

test("exhaustive match narrows each case", () => {
  const size = (s: Shape) =>
    match(s, {
      circle: (v) => `circle r=${v.radius}`,
      square: (v) => `square s=${v.side}`,
      line: (v) => `line l=${v.length}`,
    });

  expect(shapes.map(size)).toMatchInlineSnapshot(`
    [
      "circle r=7",
      "square s=3",
      "line l=5",
    ]
  `);
});

test("partial match falls through to _ with the unhandled cases", () => {
  const size = (s: Shape) =>
    match(s, {
      circle: (v) => v.radius,
      _: (v) => ("side" in v ? v.side : v.length),
    });

  expect(shapes.map(size)).toMatchInlineSnapshot(`
    [
      7,
      3,
      5,
    ]
  `);
});

test("_ only match handles everything", () => {
  expect(shapes.map((s) => match(s, { _: (v) => v.kind }))).toMatchInlineSnapshot(`
    [
      "circle",
      "square",
      "line",
    ]
  `);
});

test("exhaustive plus _ prefers the specific case", () => {
  const r = shapes.map((s) =>
    match(s, {
      circle: () => "specific circle",
      square: () => "specific square",
      line: () => "specific line",
      _: () => "fallthrough",
    }),
  );
  expect(r).toMatchInlineSnapshot(`
    [
      "specific circle",
      "specific square",
      "specific line",
    ]
  `);
});

test("union kind objects dispatch on their runtime kind", () => {
  const ab = (v: { kind: "a" | "b"; x: number }) => match(v, { a: (v) => v.x, b: (v) => -v.x });
  expect([ab({ kind: "a", x: 5 }), ab({ kind: "b", x: 5 })]).toMatchInlineSnapshot(`
    [
      5,
      -5,
    ]
  `);
});

test("R infers without contextual help", () => {
  const r = match(shapes[0] as Shape, { circle: (v) => v.radius, _: () => -1 });
  const witness: number = r;
  expect(witness).toMatchInlineSnapshot(`7`);
});

// Compile-only: never called, just typechecked.
export function compileOnly(s: Shape): void {
  // @ts-expect-error missing case without _ is rejected
  match(s, { circle: (v) => v.radius, square: (v) => v.side });

  // @ts-expect-error partial without _ is rejected
  match(s, { circle: (v) => v.radius });

  // @ts-expect-error bogus key is rejected
  match(s, { blob: () => 0, _: () => 0 });

  // @ts-expect-error handler param is narrowed, not the whole union
  match(s, { circle: (v: { kind: "square" }) => 0, _: () => 0 });

  // _ receives only the unhandled cases
  match(s, { circle: (v) => v.radius, _: (_v: { kind: "square"; side: number } | { kind: "line"; length: number }) => 0 });

  // side-effect match with discarded result still typechecks
  match(s, { circle: (v) => void v.radius, _: () => {} });
}

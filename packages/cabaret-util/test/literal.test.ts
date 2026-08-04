import { expect, test } from "vitest";
import { Literal } from "../src/index.ts";

test("exhaustive match over pure literals", () => {
  const toggle = (b: boolean) => Literal.match(b, { true: () => "on", false: () => "off" });

  type Status = 200 | 404 | 500;
  const label = (s: Status) => Literal.match(s, { 200: () => "ok", 404: () => "missing", 500: () => "broken" });

  expect({
    toggles: [toggle(true), toggle(false)],
    labels: [label(200), label(404), label(500)],
  }).toMatchInlineSnapshot(`
    {
      "labels": [
        "ok",
        "missing",
        "broken",
      ],
      "toggles": [
        "on",
        "off",
      ],
    }
  `);
});

test("mixed literals with fallthrough", () => {
  type V = "on" | "off" | 404 | null | undefined;
  const f = (v: V) =>
    Literal.match(v, {
      on: () => "handled: on",
      404: (n) => `handled: ${n}`,
      _: (rest) => `fell through: ${String(rest)}`,
    });

  expect((["on", "off", 404, null, undefined] as V[]).map(f)).toMatchInlineSnapshot(`
    [
      "handled: on",
      "fell through: off",
      "handled: 404",
      "fell through: null",
      "fell through: undefined",
    ]
  `);
});

test("a key covers both the literal and its string form", () => {
  // Exhaustive: both members share the "null" tag, so one handler suffices
  // and its param is the union.
  const f = (v: "null" | null) =>
    Literal.match(v, {
      null: (x) => (x === null ? "the literal null" : `the string ${JSON.stringify(x)}`),
    });

  const g = (v: "404" | 404) => Literal.match(v, { 404: (x) => `${typeof x}: ${x}` });

  expect([f(null), f("null"), g(404), g("404")]).toMatchInlineSnapshot(`
    [
      "the literal null",
      "the string "null"",
      "number: 404",
      "string: 404",
    ]
  `);
});

test("non-literal values are allowed and fall through to _", () => {
  const f = (v: { x: number } | null) =>
    Literal.match(v, {
      null: () => -1,
      _: (obj) => obj.x,
    });

  expect([f(null), f({ x: 7 })]).toMatchInlineSnapshot(`
    [
      -1,
      7,
    ]
  `);
});

// Compile-only: never called, just typechecked.
export function compileOnly(): void {
  const status = 200 as 200 | 404;

  // @ts-expect-error missing literal case without _ is rejected
  Literal.match(status, { 200: () => 0 });

  // handler params narrow to the single literal
  Literal.match(status, { 200: (v: 200) => v, 404: (v: 404) => v });

  // _ receives only the unhandled cases
  Literal.match(status, { 200: (v) => v, _: (rest: 404) => rest });
}

import { expect, test } from "vitest";
import { ADT, match } from "../src/index.ts";

type Shape = ADT<{ circle: { radius: number }; square: { side: number } }>;

const shapes: Shape[] = [
  { kind: "circle", radius: 7 },
  { kind: "square", side: 3 },
];

test("exhaustive match over adts narrows each case", () => {
  const size = (s: Shape) =>
    match(s, {
      circle: (v) => `circle r=${v.radius}`,
      square: (v) => `square s=${v.side}`,
    });

  expect(shapes.map(size)).toMatchInlineSnapshot(`
    [
      "circle r=7",
      "square s=3",
    ]
  `);
});

test("exhaustive match over literals", () => {
  const toggle = (b: boolean) => match(b, { true: () => "on", false: () => "off" });

  type Status = 200 | 404;
  const label = (s: Status) => match(s, { 200: () => "ok", 404: () => "missing" });

  expect([toggle(true), toggle(false), label(200), label(404)]).toMatchInlineSnapshot(`
    [
      "on",
      "off",
      "ok",
      "missing",
    ]
  `);
});

test("literals and adts fuse in one union", () => {
  type State = "idle" | null | ADT<{ busy: { task: string } }>;

  const show = (s: State) =>
    match(s, {
      idle: () => "idle",
      null: () => "unknown",
      busy: (v) => `busy: ${v.task}`,
    });

  expect([show("idle"), show(null), show({ kind: "busy", task: "paint" })]).toMatchInlineSnapshot(`
    [
      "idle",
      "unknown",
      "busy: paint",
    ]
  `);
});

test("partial match falls through to _ with the unhandled cases", () => {
  type State = "idle" | ADT<{ busy: { task: string }; done: { ok: boolean } }>;
  const states: State[] = ["idle", { kind: "busy", task: "paint" }, { kind: "done", ok: true }];

  const f = (s: State) =>
    match(s, {
      busy: (v) => v.task,
      _: (rest) => (rest === "idle" ? "idle" : `done ok=${rest.ok}`),
    });

  expect(states.map(f)).toMatchInlineSnapshot(`
    [
      "idle",
      "paint",
      "done ok=true",
    ]
  `);
});

test("nullish strings go to the catch-all, real nullish to their keys", () => {
  type V = "null" | "undefined" | null | undefined;
  const f = (v: V) =>
    match(v, {
      null: () => "the value null",
      undefined: () => "the value undefined",
      _: (s) => `the string ${JSON.stringify(s)}`,
    });

  expect(([null, undefined, "null", "undefined"] as V[]).map(f)).toMatchInlineSnapshot(`
    [
      "the value null",
      "the value undefined",
      "the string "null"",
      "the string "undefined"",
    ]
  `);
});

test("without a catch-all, nullish strings share the explicit key", () => {
  const f = (v: "null" | null) => match(v, { null: (x) => (x === null ? "the value" : "the string") });
  expect([f(null), f("null")]).toMatchInlineSnapshot(`
    [
      "the value",
      "the string",
    ]
  `);
});

// Compile-only: never called, just typechecked.
export function compileOnly(s: Shape, t: "idle" | Shape): void {
  // @ts-expect-error missing adt case without _ is rejected
  match(s, { circle: (v) => v.radius });

  // @ts-expect-error missing literal case without _ is rejected
  match(t, { circle: (v) => v.radius, square: (v) => v.side });

  // @ts-expect-error bogus key is rejected
  match(s, { blob: () => 0, _: () => 0 });

  // _ receives only the unhandled cases
  match(t, { idle: () => 0, circle: (v) => v.radius, _: (rest: { kind: "square"; side: number }) => rest.side });

  // with a catch-all, the null key narrows to the value and _ receives the string
  match("null" as "null" | null, { null: (x: null) => x, _: (s: "null") => s });
}

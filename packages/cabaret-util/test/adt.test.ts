import { expect, test } from "vitest";
import { Enum, match, Result } from "../src/index.ts";

type Shape = Enum<{ circle: { radius: number }; square: { side: number } }>;

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
  type State = "idle" | null | Enum<{ busy: { task: string } }>;

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
  type State = "idle" | Enum<{ busy: { task: string }; done: { ok: boolean } }>;
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

test("untagged members match by nullness and fall through to _", () => {
  const f = (d: Date | null) => match(d, { null: () => "absent", _: (v) => `at ${v.getTime()}` });
  expect([f(null), f(new Date(0))]).toMatchInlineSnapshot(`
    [
      "absent",
      "at 0",
    ]
  `);
});

test("an untagged member does not impersonate the undefined key", () => {
  const f = (d: Date | undefined) => match(d, { undefined: () => "absent", _: (v) => `at ${v.getTime()}` });
  expect([f(undefined), f(new Date(0))]).toMatchInlineSnapshot(`
    [
      "absent",
      "at 0",
    ]
  `);
});

test("a kind named null is untagged and routes to the catch-all", () => {
  type V = null | { kind: "null"; x: number };
  const f = (v: V) => match(v, { null: () => "the value", _: (o) => `kind null x=${o.x}` });
  expect([f(null), f({ kind: "null", x: 7 })]).toMatchInlineSnapshot(`
    [
      "the value",
      "kind null x=7",
    ]
  `);
});

test("bigints fuse with numeric keys; functions and symbols only reach _", () => {
  const f = (g: (() => number) | null) => match(g, { null: () => -1, _: (fn) => fn() });
  const g = (v: 1n | 1) => match(v, { 1: (x) => `the ${typeof x}` });
  const s = (v: symbol | null) => match(v, { null: () => "nil", _: (x) => typeof x });
  expect([f(null), f(() => 7), g(1), g(1n), s(null), s(Symbol("x"))]).toMatchInlineSnapshot(`
    [
      -1,
      7,
      "the number",
      "the bigint",
      "nil",
      "symbol",
    ]
  `);
});

test("generator branches pass their yields through to the enclosing generator", () => {
  const positive = (n: number): Result.T<number, Error> =>
    n > 0 ? Result.Ok(n) : Result.Err(new Error(`not positive: ${n}`));

  const area = (s: Shape) =>
    Result.gen(function* () {
      return yield* match(s, {
        *circle(v) {
          return 3 * (yield* Result.bind(positive(v.radius))) ** 2;
        },
        *square(v) {
          return (yield* Result.bind(positive(v.side))) ** 2;
        },
      });
    });

  expect([area({ kind: "circle", radius: 7 }), area({ kind: "square", side: -3 })]).toMatchInlineSnapshot(`
    [
      {
        "kind": "Ok",
        "ok": 147,
      },
      {
        "err": [Error: not positive: -3],
        "kind": "Err",
      },
    ]
  `);
});

test("generator match with a catch-all and a non-yielding branch", () => {
  const f = (s: "idle" | Shape) =>
    Result.gen(function* () {
      return yield* match(s, {
        *idle() {
          return yield* Result.bind<number, Error>(Result.Err(new Error("idle")));
        },
        *_(v) {
          return v.kind.length;
        },
      });
    });

  expect([f("idle"), f({ kind: "square", side: 3 })]).toMatchInlineSnapshot(`
    [
      {
        "err": [Error: idle],
        "kind": "Err",
      },
      {
        "kind": "Ok",
        "ok": 6,
      },
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

  // reserved tags are honest in the types: the null key claims only the value,
  // and _ receives the string
  match("null" as "null" | null, { null: (x: null) => x, _: (s: "null") => s });

  // exhaustive matches have no catch-all, so reserved strings and kinds fuse into their raw key
  match("null" as "null" | null, { null: (x: "null" | null) => x });
  match({ kind: "null" } as { kind: "null" } | null, { null: (x: { kind: "null" } | null) => x });

  // an exhaustive match with no contextual type still infers R from the branches
  match(s, { circle: (v) => v.radius, square: (v) => v.side }) satisfies number;

  // @ts-expect-error untagged members have no key, so the match cannot be exhaustive
  match(new Date() as Date | null, { null: () => 0 });

  // @ts-expect-error an untagged member cannot be claimed by a key
  match(new Date() as Date | null, { null: () => 0, date: (d: Date) => d, _: () => 0 });

  // @ts-expect-error a generator match without a catch-all must be exhaustive
  match(s, { *circle(v) { return v.radius; } });

  // @ts-expect-error a generator match rejects bogus keys
  match(s, { *blob() { return 0; }, *_() { return 0; } });
}

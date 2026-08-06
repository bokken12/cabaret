import { expect, test } from "vitest";
import { Maybe, NoResume, Result } from "../src/index.ts";

test("Result.gen runs binds and short-circuits on Err", () => {
  const div = (n: number, d: number): Result.T<number, Error> =>
    d === 0 ? Result.Err(new Error(`${n} / 0`)) : Result.Ok(n / d);

  const f = (a: number, b: number) =>
    Result.gen(function* () {
      const x = yield* Result.bind(div(a, b));
      const y = yield* Result.bind(div(b, a));
      return x + y;
    });

  expect([f(4, 2), f(1, 0)]).toMatchInlineSnapshot(`
    [
      {
        "kind": "Ok",
        "ok": 2.5,
      },
      {
        "err": [Error: 1 / 0],
        "kind": "Err",
      },
    ]
  `);
});

test("Maybe.gen runs binds and short-circuits on undefined", () => {
  const f = (a: Maybe.T<number>, b: Maybe.T<number>) =>
    Maybe.gen(function* () {
      return (yield* Maybe.bind(a)) + (yield* Maybe.bind(b));
    });

  expect([f(1, 2), f(1, undefined)]).toMatchInlineSnapshot(`
    [
      3,
      undefined,
    ]
  `);
});

// Compile-only: never called, just typechecked.
export function compileOnly(g: Generator<Error, number, NoResume.T>): void {
  // argumentless next() must stay legal: it is how the gen runners drive the body
  g.next();

  // @ts-expect-error no value of NoResume.T exists to resume with
  g.next("nope");

  // @ts-expect-error not even undefined
  g.next(undefined);
}

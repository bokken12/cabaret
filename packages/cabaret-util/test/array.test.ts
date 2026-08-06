import { expect, test } from "vitest";
import { Array, Result } from "../src/index.ts";

test("partition splits by Ok/Err, preserving order", () => {
  expect(
    Array.partition([1, 2, 3, 4, 5], (n) => (n % 2 === 0 ? Result.Ok(n) : Result.Err(`odd: ${n}`))),
  ).toMatchInlineSnapshot(`
    [
      [
        2,
        4,
      ],
      [
        "odd: 1",
        "odd: 3",
        "odd: 5",
      ],
    ]
  `);
});

test("partition of an empty array is a pair of empty arrays", () => {
  expect(Array.partition([], () => Result.Ok(0))).toMatchInlineSnapshot(`
    [
      [],
      [],
    ]
  `);
});

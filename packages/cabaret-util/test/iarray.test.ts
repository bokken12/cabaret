import { expect, test } from "vitest";
import { Iarray, Result } from "../src/index.ts";

test("partition splits by Ok/Err, preserving order", () => {
  const t: Iarray.T<number> = [1, 2, 3, 4, 5];
  expect(
    Iarray.partition(t, (n) => (n % 2 === 0 ? Result.Ok(n) : Result.Err(`odd: ${n}`))),
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

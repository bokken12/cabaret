import { expect, test } from "vitest";
import { OrNull } from "../src/index.ts";

test("map applies f to non-null values and passes null through", () => {
  expect([
    OrNull.map(3, (n: number) => n * 2),
    OrNull.map(null as OrNull.T<number>, (n) => n * 2),
  ]).toMatchInlineSnapshot(`
    [
      6,
      null,
    ]
  `);
});

test("map is not confused by values whose stringification looks null-ish", () => {
  expect([
    OrNull.map("null", (s: string) => s.toUpperCase()),
    OrNull.map("undefined", (s: string) => s.toUpperCase()),
  ]).toMatchInlineSnapshot(`
    [
      "NULL",
      "UNDEFINED",
    ]
  `);
});

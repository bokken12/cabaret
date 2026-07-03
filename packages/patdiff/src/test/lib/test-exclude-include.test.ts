/** Port of OCaml's [patdiff/test/src/test_exclude_include.ml]. */

import { describe, expect, it } from "vitest";
import { patdiffDir } from "./_helpers.js";

const filenames = ["foo", "bar", "baz"] as const;

const test = (extraFlags: ReadonlyArray<string | readonly [string, string]>): string => {
  return patdiffDir({
    extraFlags: ["-ascii", ...extraFlags],
    prev: filenames.map((p) => [p, "prev\n"]),
    next: filenames.map((p) => [p, "next\n"]),
  });
};

describe("exclude/include", () => {
  it("patdiff", () => {
    expect(test([])).toMatchInlineSnapshot(`
      "------ prev/bar
      ++++++ next/bar
      @|-1,1 +1,1 ============================================================
      -|prev
      +|next
      ------ prev/baz
      ++++++ next/baz
      @|-1,1 +1,1 ============================================================
      -|prev
      +|next
      ------ prev/foo
      ++++++ next/foo
      @|-1,1 +1,1 ============================================================
      -|prev
      +|next
      ("Unclean exit" (Exit_non_zero 1))
      "
    `);
  });

  it("patdiff -exclude bar", () => {
    expect(test(["-exclude", "bar"])).toMatchInlineSnapshot(`
      "------ prev/baz
      ++++++ next/baz
      @|-1,1 +1,1 ============================================================
      -|prev
      +|next
      ------ prev/foo
      ++++++ next/foo
      @|-1,1 +1,1 ============================================================
      -|prev
      +|next
      ("Unclean exit" (Exit_non_zero 1))
      "
    `);
  });

  it("patdiff -include bar|baz", () => {
    expect(test(["-include", "bar|baz"])).toMatchInlineSnapshot(`
      "------ prev/bar
      ++++++ next/bar
      @|-1,1 +1,1 ============================================================
      -|prev
      +|next
      ------ prev/baz
      ++++++ next/baz
      @|-1,1 +1,1 ============================================================
      -|prev
      +|next
      ("Unclean exit" (Exit_non_zero 1))
      "
    `);
  });

  it("patdiff -include bar|baz -exclude baz", () => {
    expect(test(["-include", "bar|baz", "-exclude", "baz"])).toMatchInlineSnapshot(`
      "------ prev/bar
      ++++++ next/bar
      @|-1,1 +1,1 ============================================================
      -|prev
      +|next
      ("Unclean exit" (Exit_non_zero 1))
      "
    `);
  });
});

/** Port of OCaml's [patdiff/test/src/test_float_tolerance.ml]. */

import { describe, expect, it } from "vitest";
import { patdiff } from "./_helpers.js";

const diff = (prev: string, next: string, tolerance: string, message: string): string => {
  const out = patdiff({
    prev,
    next,
    extraFlags: ["-float-tolerance", tolerance, "-ascii"],
  });
  return `====== ${message} ======\n${out}`;
};

const test = (prev: string, next: string): string => {
  return diff(prev, next, "0x", "strict") + diff(prev, next, "10%", "10%");
};

describe("float tolerance", () => {
  it("simple deletion", () => {
    const prev = `
 foo
 bar
 bax
 baz
`;
    const next = `
 foo
 bar
 baz
`;
    expect(test(prev, next)).toMatchInlineSnapshot(`
      "====== strict ======
      ------ prev/file
      ++++++ next/file
      @|-1,5 +1,4 ============================================================
       |
       | foo
       | bar
      -| bax
       | baz
      ("Unclean exit" (Exit_non_zero 1))
      ====== 10% ======
      ------ prev/file
      ++++++ next/file
      @|-1,5 +1,4 ============================================================
       |
       | foo
       | bar
      -| bax
       | baz
      ("Unclean exit" (Exit_non_zero 1))
      "
    `);
  });

  it("fruit sexp diffs", () => {
    const prev = `((apples 12345678 23456789))
 (bananas (09:30:00.000000 16:00:00.000000))
 (clementines 10s) (durian 50ms)
 (elderberries 1s) (figs 2s)
 (grapes 2)
 (huckleberries 4096) (i_don't_know_any_fruit_starting_with_i 100ms)
 (jujubes 50ms) (kiwis 1000000)
 (limes 30)
 (mangos 10000)
 (nectarines 1.66667m)
 (oranges 1.66667m) (persimmons 17:15:00.000000)
 (quinces ((size 50000) (shelf_life 50s)))
 (raspberries true)
 (strawberries (are_red Surprisingly_not_always))
 (tamarind ())
 (ugli_fruits 30s))
`;
    const next = `((apples 12345678 23456788))
 (bananas (09:30:00.000000 15:59:00.000000))
 (clementines 10s) (durian 50ms)
 (elderberries 1s) (figs 2s)
 (grapes 2)
 (huckleberries 8192) (i_don't_know_any_fruit_starting_with_i 100ms)
 (jujubes 50ms) (kiwis 1000000)
 (limes 32)
 (mangos 10000)
 (nectarines 1.667m)
 (oranges 1.66667m) (persimmons 17:15:00.000000)
 (quinces ((size 49000) (shelf_life 50s)))
 (raspberries true)
 (strawberries (are_red Surprisingly_not_always))
 (tamarind ())
 (ugli_fruits 32s))
`;
    expect(test(prev, next)).toMatchInlineSnapshot(`
      "====== strict ======
      ------ prev/file
      ++++++ next/file
      @|-1,16 +1,16 ============================================================
      -|((apples 12345678 23456789))
      -| (bananas (09:30:00.000000 16:00:00.000000))
      +|((apples 12345678 23456788))
      +| (bananas (09:30:00.000000 15:59:00.000000))
       | (clementines 10s) (durian 50ms)
       | (elderberries 1s) (figs 2s)
       | (grapes 2)
      -| (huckleberries 4096) (i_don't_know_any_fruit_starting_with_i 100ms)
      +| (huckleberries 8192) (i_don't_know_any_fruit_starting_with_i 100ms)
       | (jujubes 50ms) (kiwis 1000000)
      -| (limes 30)
      +| (limes 32)
       | (mangos 10000)
      -| (nectarines 1.66667m)
      +| (nectarines 1.667m)
       | (oranges 1.66667m) (persimmons 17:15:00.000000)
      -| (quinces ((size 50000) (shelf_life 50s)))
      +| (quinces ((size 49000) (shelf_life 50s)))
       | (raspberries true)
       | (strawberries (are_red Surprisingly_not_always))
       | (tamarind ())
      -| (ugli_fruits 30s))
      +| (ugli_fruits 32s))
      ("Unclean exit" (Exit_non_zero 1))
      ====== 10% ======
      ------ prev/file
      ++++++ next/file
      @|-1,16 +1,16 ============================================================
       |((apples 12345678 23456788))
      -| (bananas (09:30:00.000000 16:00:00.000000))
      +| (bananas (09:30:00.000000 15:59:00.000000))
       | (clementines 10s) (durian 50ms)
       | (elderberries 1s) (figs 2s)
       | (grapes 2)
      -| (huckleberries 4096) (i_don't_know_any_fruit_starting_with_i 100ms)
      +| (huckleberries 8192) (i_don't_know_any_fruit_starting_with_i 100ms)
       | (jujubes 50ms) (kiwis 1000000)
       | (limes 32)
       | (mangos 10000)
       | (nectarines 1.667m)
       | (oranges 1.66667m) (persimmons 17:15:00.000000)
       | (quinces ((size 49000) (shelf_life 50s)))
       | (raspberries true)
       | (strawberries (are_red Surprisingly_not_always))
       | (tamarind ())
       | (ugli_fruits 32s))
      ("Unclean exit" (Exit_non_zero 1))
      "
    `);
  });
});

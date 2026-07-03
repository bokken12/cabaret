/** Port of OCaml's [patdiff/test/src/test_float_tolerance_dropped_diff.ml].
 *  Regression test for a case where we used to drop the first line of the diff. */

import { describe, expect, it } from "vitest";
import { patdiff } from "./_helpers.js";

const prev = `
((foo (1 2))
 (bar 0.5%))
`;

const next = `
()
`;

describe("float tolerance dropped diff", () => {
  it("default", () => {
    expect(patdiff({ prev, next })).toMatchInlineSnapshot(`
      "(fg:red)------ (fg:default +bold)prev/file(-weight)
      (fg:green)++++++ (fg:default +bold)next/file(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,3 +1,2(-weight) ============================================================
      (bg:gray fg:black) |(bg:default fg:default)
      (bg:yellow fg:black)!|(bg:default fg:default)((fg:red)(foo (1 2))(fg:default)
      (bg:yellow fg:black)!|(bg:default fg:red) (bar 0.5%)(fg:default))
      ("Unclean exit" (Exit_non_zero 1))
      "
    `);
  });

  it("-float-tolerance 0x", () => {
    expect(patdiff({ prev, next, extraFlags: ["-float-tolerance", "0x"] })).toMatchInlineSnapshot(`
      "(fg:red)------ (fg:default +bold)prev/file(-weight)
      (fg:green)++++++ (fg:default +bold)next/file(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,3 +1,2(-weight) ============================================================
      (bg:gray fg:black) |(bg:default fg:default)
      (bg:yellow fg:black)!|(bg:default fg:default)((fg:red)(foo (1 2))(fg:default)
      (bg:yellow fg:black)!|(bg:default fg:red) (bar 0.5%)(fg:default))
      ("Unclean exit" (Exit_non_zero 1))
      "
    `);
  });

  it("-float-tolerance 0x -no-semantic-cleanup", () => {
    expect(
      patdiff({
        prev,
        next,
        extraFlags: ["-float-tolerance", "0x", "-no-semantic-cleanup"],
      }),
    ).toMatchInlineSnapshot(`
      "(fg:red)------ (fg:default +bold)prev/file(-weight)
      (fg:green)++++++ (fg:default +bold)next/file(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,3 +1,2(-weight) ============================================================
      (bg:gray fg:black) |(bg:default fg:default)
      (bg:yellow fg:black)!|(bg:default fg:default)((fg:red)(foo (1 2))(fg:default)
      (bg:yellow fg:black)!|(bg:default fg:red) (bar 0.5%)(fg:default))
      ("Unclean exit" (Exit_non_zero 1))
      "
    `);
  });
});

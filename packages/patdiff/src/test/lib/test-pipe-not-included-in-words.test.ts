/** Port of OCaml's [patdiff/test/src/test_pipe_not_included_in_words.ml]. */

import { describe, expect, it } from "vitest";
import { patdiff } from "./_helpers.js";

const prev = `
min=0|max=10
`;

const next = `
min=5|max=10
`;

describe("pipe is not part of words", () => {
  it("pipe", () => {
    const out = patdiff({ prev, next });
    expect(out).toMatchInlineSnapshot(`
      "(fg:red)------ (fg:default +bold)prev/file(-weight)
      (fg:green)++++++ (fg:default +bold)next/file(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,2 +1,2(-weight) ============================================================
      (bg:gray fg:black) |(bg:default fg:default)
      (bg:red fg:black)-|(off fg:gray-12)min=(fg:red)0(fg:gray-12)|max=10(fg:default)
      (bg:green fg:black)+|(off)min=(fg:green)5(fg:default)|max=10
      ("Unclean exit" (Exit_non_zero 1))
      "
    `);
  });
});

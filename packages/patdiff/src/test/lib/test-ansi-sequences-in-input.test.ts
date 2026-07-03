/** Port of OCaml's [patdiff/test/src/test_ansi_sequences_in_input.ml]. */

import { describe, expect, it } from "vitest";
import { patdiff } from "./_helpers.js";

const aansi = "\x1b[0;1m\n";
const bansi = "\x1b[0;2m\n";

const acoloredText = "\x1b[0;33myellow text\x1b[0m\n";
const bcoloredText = "\x1b[0;34mblue text\x1b[0m\n";

describe("ansi sequences in input", () => {
  it("ansi escape code in input", () => {
    expect(patdiff({ prev: aansi, next: bansi })).toMatchInlineSnapshot(`
      "(fg:red)------ (fg:default +bold)prev/file(-weight)
      (fg:green)++++++ (fg:default +bold)next/file(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,1 +1,1(-weight) ============================================================
      (bg:red fg:black)-|(off +bold fg:default)
      (bg:green fg:black)+|(off +faint fg:default)
      ("Unclean exit" (Exit_non_zero 1))
      "
    `);
  });

  it("colored text", () => {
    expect(patdiff({ prev: acoloredText, next: bcoloredText })).toMatchInlineSnapshot(`
      "(fg:red)------ (fg:default +bold)prev/file(-weight)
      (fg:green)++++++ (fg:default +bold)next/file(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,1 +1,1(-weight) ============================================================
      (bg:red fg:black)-|(off fg:yellow)yellow(fg:gray-12) text(fg:default)
      (bg:green fg:black)+|(off fg:blue)blue(fg:default) text
      ("Unclean exit" (Exit_non_zero 1))
      "
    `);
  });
});

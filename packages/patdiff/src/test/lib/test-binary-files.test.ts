/** Port of OCaml's [patdiff/test/src/test_binary_files.ml]. */

import { describe, expect, it } from "vitest";
import { patdiff } from "./_helpers.js";

describe("binary files", () => {
  it("message when non-ASCII text files differ", () => {
    const prev =
      "┌Signals──┐┌Values───┐┌Waves─────────┐\n" +
      "      │clock    ││         ││┌───┐   ┌───┐ │\n" +
      "      │         ││         ││    └───┘   └─│\n";
    const next =
      "┌Signals──┐┌Values───┐┌Waves─────────┐\n" +
      "      │clock2   ││         ││┌───┐   ┌───┐ │\n" +
      "      │         ││         ││    └───┘   └─│\n";
    const out = patdiff({
      prev,
      next,
      extraFlags: ["-location-style", "omake"],
    });
    expect(out).toMatchInlineSnapshot(`
      "(fg:red)------ (fg:default +bold)prev/file(-weight)
      (fg:green)++++++ (fg:default +bold)next/file(-weight)
      File "prev/file", line 2, characters 0-1:
      (bg:gray fg:black) |(bg:default fg:default)┌Signals──┐┌Values───┐┌Waves─────────┐
      (bg:red fg:black)-|(off fg:red)      │clock(fg:gray-12)    ││         ││┌───┐   ┌───┐ │(fg:default)
      (bg:green fg:black)+|(off fg:green)      │clock2(fg:default)   ││         ││┌───┐   ┌───┐ │
      (bg:gray fg:black) |(bg:default fg:default)      │         ││         ││    └───┘   └─│
      ("Unclean exit" (Exit_non_zero 1))
      "
    `);
  });

  it("message when binary files differ", () => {
    const len = 100;
    const bytes = new Uint8Array(len).fill(0x7a /* 'z' */);
    bytes[50] = 0x00;
    const prev = Buffer.from(bytes).toString("binary");
    bytes[51] = 0x01;
    const next = Buffer.from(bytes).toString("binary");
    const out = patdiff({
      prev,
      next,
      extraFlags: ["-location-style", "omake"],
    });
    // Not-a-bug drift: OCaml's [Expect_test_helpers.system] helper inserts
    // a blank line after a child-process exit when the child's output doesn't
    // already end with one. The patdiff CLI itself produces only
    // [binary files differ\n] -- the blank line in OCaml's snapshot is from
    // its test harness, not from patdiff. TS's test helper appends the
    // [Unclean exit] line directly, with no blank.
    expect(out).toMatchInlineSnapshot(`
      "File "prev/file", line 1, characters 0-1:
        File "next/file"
        binary files differ
      ("Unclean exit" (Exit_non_zero 1))
      "
    `);
  });
});

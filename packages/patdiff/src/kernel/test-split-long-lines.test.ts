/** Translation of OCaml [test_split_long_lines.ml].
 *
 *  Acceptable drift from OCaml ground truth: the [printHunksSexp] output is a
 *  single-line, machine-readable sexp instead of OCaml's pretty-printed
 *  [Sexp.to_string_hum] form. The sexp values are structurally identical;
 *  only the line wrapping/indentation differs. */

import { describe, expect, it } from "vitest";
import { strip } from "../shared/string-util.js";
import * as Format from "./format.js";
import { defaultContext, defaultLineBigEnough, defaultWordBigEnough, withoutUnix } from "./patdiff-core.js";
import { printHunksSexp } from "./sexp-helpers.js";

describe("test_split_long_lines", () => {
  it("refine does not raise with ~split_long_lines:true and no controlling tty", () => {
    const keepWs = false;
    let hunks = withoutUnix.diff({
      context: defaultContext,
      lineBigEnough: defaultLineBigEnough,
      keepWs,
      findMoves: false,
      prev: ["hello", "world"],
      next: ["good bye", "world"],
    });
    hunks = withoutUnix.refine({
      rules: Format.Rules.defaultRules,
      output: "Ascii",
      splitLongLines: true,
      produceUnifiedLines: false,
      keepWs,
      interleave: true,
      wordBigEnough: defaultWordBigEnough,
      hunks,
    });
    expect(printHunksSexp(hunks)).toMatchInlineSnapshot(
      `"(((prev_start 1) (prev_size 2) (next_start 1) (next_size 2) (ranges ((Replace (hello) ("good bye") ()) (Same ((world world)))))))"`,
    );
  });

  const printPatdiff = (prev: string, next: string): string =>
    withoutUnix.patdiff({
      produceUnifiedLines: false,
      output: "Ascii",
      prev: { name: "old", text: prev },
      next: { name: "new", text: next },
    });

  it("extra empty lines are not added", () => {
    expect(printPatdiff("hello world", "hello")).toMatchInlineSnapshot(`
      "-1,1 +1,1
      -|hello world
      +|hello"
    `);
    expect(printPatdiff("hello world", "world")).toMatchInlineSnapshot(`
      "-1,1 +1,1
      -|hello world
      +|world"
    `);
    expect(printPatdiff("hello world", "")).toMatchInlineSnapshot(`
      "-1,1 +1,0
      -|hello world"
    `);
  });

  it("extra empty lines are not added for consecutive long lines", () => {
    const prev = strip(`
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0000000000000000000000000000000000000000
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 1111111111111111111111111111111111111111
`);
    const next = strip(`
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
`);
    expect(printPatdiff(prev, next)).toMatchInlineSnapshot(`
      "-1,2 +1,2
      -|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0000000000000000000000000000000000000000
      -|bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 1111111111111111111111111111111111111111
      +|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      +|bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    `);
  });

  it("a shared tail past the length budget splits without dropping its newline", () => {
    // The added run spends the line budget just before a multi-word shared
    // tail, so the split breaks mid-line; the flushed chunk must still end
    // with a newline or [collapse] rejects it.
    const prev = "shared words at the end.\n";
    const next = `${"x".repeat(70)} shared words at the end.\n`;
    expect(printPatdiff(prev, next)).toMatchInlineSnapshot(`
      "-1,1 +1,1
      -|shared
      +|xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx shared
         words at the end."
    `);
  });
});

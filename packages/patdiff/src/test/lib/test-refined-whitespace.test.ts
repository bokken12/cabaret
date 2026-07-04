/** Port of OCaml's [patdiff/test/src/test_refined_whitespace.ml]. */

import { describe, expect, it } from "vitest";
import { patdiff } from "./_helpers.js";

const run = (prev: string, next: string, extra: ReadonlyArray<string> = []): string =>
  patdiff({ prev, next, extraFlags: ["-keep-whitespace", ...extra] });

describe("refined whitespace", () => {
  it("show added newline at start of input", () => {
    expect(run("bar\n", "\n bar\n")).toMatchInlineSnapshot(`
      "(fg:red)------ (fg:default +bold)prev/file(-weight)
      (fg:green)++++++ (fg:default +bold)next/file(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,1 +1,2(-weight) ============================================================
      (bg:red fg:black)-|(off fg:gray-12)bar(fg:default)
      (bg:green fg:black)+|(off)
      (bg:green fg:black)+|(off +invert fg:green) (-invert fg:default)bar
      ("Unclean exit" (Exit_non_zero 1))
      "
    `);
  });

  it("-unrefined works too", () => {
    expect(run("bar\n", "\n bar\n", ["-unrefined"])).toMatchInlineSnapshot(`
      "(fg:red)------ (fg:default +bold)prev/file(-weight)
      (fg:green)++++++ (fg:default +bold)next/file(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,1 +1,2(-weight) ============================================================
      (bg:red fg:black)-|(bg:default fg:red)bar(fg:default)
      (bg:green fg:black)+|(bg:default fg:default)
      (bg:green fg:black)+|(bg:default fg:green) bar(fg:default)
      ("Unclean exit" (Exit_non_zero 1))
      "
    `);
  });

  it("-ascii works too (it implies -unrefined)", () => {
    expect(run("bar\n", "\n bar\n", ["-ascii"])).toMatchInlineSnapshot(`
      "------ prev/file
      ++++++ next/file
      @|-1,1 +1,2 ============================================================
      -|bar
      +|
      +| bar
      ("Unclean exit" (Exit_non_zero 1))
      "
    `);
  });

  it("show leading whitespace", () => {
    expect(run("bar\n", " bar\n")).toMatchInlineSnapshot(`
      "(fg:red)------ (fg:default +bold)prev/file(-weight)
      (fg:green)++++++ (fg:default +bold)next/file(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,1 +1,1(-weight) ============================================================
      (bg:red fg:black)-|(off fg:gray-12)bar(fg:default)
      (bg:green fg:black)+|(off +invert fg:green) (-invert fg:default)bar
      ("Unclean exit" (Exit_non_zero 1))
      "
    `);
  });

  it("show internal whitespace", () => {
    expect(run("foo bar\n", "foo  bar\n")).toMatchInlineSnapshot(`
      "(fg:red)------ (fg:default +bold)prev/file(-weight)
      (fg:green)++++++ (fg:default +bold)next/file(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,1 +1,1(-weight) ============================================================
      (bg:red fg:black)-|(off fg:gray-12)foo(+invert fg:red) (-invert fg:gray-12)bar(fg:default)
      (bg:green fg:black)+|(off)foo(+invert fg:green)  (-invert fg:default)bar
      ("Unclean exit" (Exit_non_zero 1))
      "
    `);
  });

  it("show trailing whitespace", () => {
    expect(run("foo\n", "foo \n")).toMatchInlineSnapshot(`
      "(fg:red)------ (fg:default +bold)prev/file(-weight)
      (fg:green)++++++ (fg:default +bold)next/file(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,1 +1,1(-weight) ============================================================
      (bg:red fg:black)-|(off fg:gray-12)foo(fg:default)
      (bg:green fg:black)+|(off)foo(+invert fg:green) (-invert fg:default)
      ("Unclean exit" (Exit_non_zero 1))
      "
    `);
  });
});

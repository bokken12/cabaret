/** Port of OCaml's [patdiff/test/src/test-new-empty.t]. */

import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkTmpDir, runCli, visibleColors, writeFileIn } from "./_helpers.js";

let tmp: string;

beforeEach(() => {
  tmp = mkTmpDir("patdiff-empty-");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("diff against empty file", () => {
  beforeEach(() => {
    writeFileIn(tmp, "prev", "oneline\n");
    writeFileIn(tmp, "next", "");
  });

  it("all red (prev -> next empty)", () => {
    const r = runCli(["-default", "prev", "next"], { cwd: tmp });
    expect(r.status).toBe(1);
    expect(visibleColors(r.stdout)).toMatchInlineSnapshot(`
      "(fg:red)------ (fg:default +bold)prev(-weight)
      (fg:green)++++++ (fg:default +bold)next(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,1 +1,0(-weight) ============================================================
      (bg:red fg:black)-|(bg:default fg:red)oneline(fg:default)
      "
    `);
  }, 30_000);

  it("all green (empty -> oneline, swapped)", () => {
    const r = runCli(["-default", "next", "prev"], { cwd: tmp });
    expect(r.status).toBe(1);
    expect(visibleColors(r.stdout)).toMatchInlineSnapshot(`
      "(fg:red)------ (fg:default +bold)next(-weight)
      (fg:green)++++++ (fg:default +bold)prev(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,0 +1,1(-weight) ============================================================
      (bg:green fg:black)+|(bg:default fg:green)oneline(fg:default)
      "
    `);
  }, 30_000);
});

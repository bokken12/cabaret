/** Port of OCaml's [patdiff/test/src/test-directory.t]. */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkTmpDir, runCli, visibleColors, writeFileIn } from "./_helpers.js";

let tmp: string;

beforeEach(() => {
  tmp = mkTmpDir("patdiff-dir-");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("directory diff", () => {
  const setupDirs = (): void => {
    fs.mkdirSync(path.join(tmp, "prev"));
    fs.mkdirSync(path.join(tmp, "prev/subdir"));
    fs.mkdirSync(path.join(tmp, "prev/foo"));
    writeFileIn(tmp, "prev/foo/bar", ".\n");
    writeFileIn(tmp, "prev/this-goes-away", ".\n");
    writeFileIn(tmp, "prev/this-changes", "prev\n");
    writeFileIn(tmp, "prev/subdir/this-changes-in-subdir", "prev\n");
    fs.mkdirSync(path.join(tmp, "next"));
    fs.mkdirSync(path.join(tmp, "next/subdir"));
    writeFileIn(tmp, "next/foo", ".\n");
    writeFileIn(tmp, "next/this-appears", ".\n");
    writeFileIn(tmp, "next/this-changes", "next\n");
    writeFileIn(tmp, "next/subdir/this-changes-in-subdir", "next\n");
  };

  it("recursive diff with -default", () => {
    setupDirs();
    const r = runCli(["-default", "prev", "next"], { cwd: tmp });
    expect(r.status).toBe(1);
    expect(visibleColors(r.stdout)).toMatchInlineSnapshot(`
      "Only in prev: this-goes-away
      (fg:red)------ (fg:default +bold)prev/this-goes-away(-weight)
      (fg:green)++++++ (fg:default +bold)/dev/null(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,1 +1,0(-weight) ============================================================
      (bg:red fg:black)-|(bg:default fg:red).(fg:default)
      Only in next: this-appears
      (fg:red)------ (fg:default +bold)/dev/null(-weight)
      (fg:green)++++++ (fg:default +bold)next/this-appears(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,0 +1,1(-weight) ============================================================
      (bg:green fg:black)+|(bg:default fg:green).(fg:default)
      Files prev/foo and next/foo are not the same type
      (fg:red)------ (fg:default +bold)prev/subdir/this-changes-in-subdir(-weight)
      (fg:green)++++++ (fg:default +bold)next/subdir/this-changes-in-subdir(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,1 +1,1(-weight) ============================================================
      (bg:red fg:black)-|(off fg:red)prev(fg:default)
      (bg:green fg:black)+|(off fg:green)next(fg:default)
      (fg:red)------ (fg:default +bold)prev/this-changes(-weight)
      (fg:green)++++++ (fg:default +bold)next/this-changes(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,1 +1,1(-weight) ============================================================
      (bg:red fg:black)-|(off fg:red)prev(fg:default)
      (bg:green fg:black)+|(off fg:green)next(fg:default)
      "
    `);
  }, 30_000);

  it("-alt-prev -alt-next renames the path prefixes", () => {
    setupDirs();
    const r = runCli(["-default", "prev", "next", "-alt-prev", "a", "-alt-next", "b"], { cwd: tmp });
    expect(r.status).toBe(1);
    expect(visibleColors(r.stdout)).toMatchInlineSnapshot(`
      "Only in a: this-goes-away
      (fg:red)------ (fg:default +bold)a/this-goes-away(-weight)
      (fg:green)++++++ (fg:default +bold)/dev/null(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,1 +1,0(-weight) ============================================================
      (bg:red fg:black)-|(bg:default fg:red).(fg:default)
      Only in b: this-appears
      (fg:red)------ (fg:default +bold)/dev/null(-weight)
      (fg:green)++++++ (fg:default +bold)b/this-appears(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,0 +1,1(-weight) ============================================================
      (bg:green fg:black)+|(bg:default fg:green).(fg:default)
      Files a/foo and b/foo are not the same type
      (fg:red)------ (fg:default +bold)a/subdir/this-changes-in-subdir(-weight)
      (fg:green)++++++ (fg:default +bold)b/subdir/this-changes-in-subdir(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,1 +1,1(-weight) ============================================================
      (bg:red fg:black)-|(off fg:red)prev(fg:default)
      (bg:green fg:black)+|(off fg:green)next(fg:default)
      (fg:red)------ (fg:default +bold)a/this-changes(-weight)
      (fg:green)++++++ (fg:default +bold)b/this-changes(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,1 +1,1(-weight) ============================================================
      (bg:red fg:black)-|(off fg:red)prev(fg:default)
      (bg:green fg:black)+|(off fg:green)next(fg:default)
      "
    `);
  }, 30_000);

  it("file vs directory fails clearly", () => {
    fs.mkdirSync(path.join(tmp, "dir"));
    writeFileIn(tmp, "dir/f", "x\n");
    writeFileIn(tmp, "f", "y\n");
    const r1 = runCli(["f", "dir/"], { cwd: tmp });
    expect(r1.status).not.toBe(0);
    expect(r1.stderr).toContain("dir/ is a directory, while f is a file");

    const r2 = runCli(["dir/f", "dir"], { cwd: tmp });
    expect(r2.status).not.toBe(0);
    expect(r2.stderr).toContain("dir is a directory, while dir/f is a file");

    const r3 = runCli(["missing", "dir"], { cwd: tmp });
    expect(r3.status).not.toBe(0);
    expect(r3.stderr).toContain("dir is a directory, while missing does not exist");
  }, 30_000);
});

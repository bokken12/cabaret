/** Port of OCaml's [patdiff/test/src/test-whitespace.t]. */

import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkTmpDir, runCli, visibleColors, writeFileIn } from "./_helpers.js";

let tmp: string;

beforeEach(() => {
  tmp = mkTmpDir("patdiff-ws-");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("whitespace handling", () => {
  const prevOneLine = "this is a file with whitespace variously applied hg across the lines in an arbitrary manner\n";
  const nextManyLines =
    "\n" +
    " this is  a file \twith  \t  whitespace\n" +
    " variously  applied\n" +
    "hg\n" +
    "across the\n" +
    "\n\n\n\n\n\n\n\n\n\n" +
    "lines in an arbitrary\n" +
    "manner\n";

  it("ignores whitespace changes by default", () => {
    writeFileIn(tmp, "prev", prevOneLine);
    writeFileIn(tmp, "next", nextManyLines);
    const r = runCli(["-default", "prev", "next"], { cwd: tmp });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  }, 30_000);

  it("no spurious diffs against self with -keep-whitespace", () => {
    writeFileIn(tmp, "next", nextManyLines);
    const r = runCli(["-default", "next", "next", "-keep-whitespace"], {
      cwd: tmp,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  }, 30_000);

  it("-keep-whitespace detects whitespace changes", () => {
    writeFileIn(tmp, "prev", prevOneLine);
    writeFileIn(tmp, "next", nextManyLines);
    const r = runCli(["-default", "prev", "next", "-keep-whitespace"], {
      cwd: tmp,
    });
    expect(r.status).toBe(1);
    expect(visibleColors(r.stdout)).toMatchInlineSnapshot(`
      "(fg:red)------ (fg:default +bold)prev(-weight)
      (fg:green)++++++ (fg:default +bold)next(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,1 +1,17(-weight) ============================================================
      (bg:red fg:black)-|(off fg:gray-12)this is(+invert fg:red) (-invert fg:gray-12)a file(+invert fg:red) (-invert fg:gray-12)with(+invert fg:red) (-invert fg:gray-12)whitespace(+invert fg:red) (-invert fg:gray-12)variously(+invert fg:red) (-invert fg:gray-12)applied(+invert fg:red) (-invert fg:gray-12)hg(+invert fg:red) (-invert fg:gray-12)across the(+invert fg:red) (-invert fg:gray-12)lines in an arbitrary(+invert fg:red) (-invert fg:gray-12)manner(fg:default)
      (bg:green fg:black)+|(off)
      (bg:green fg:black)+|(off +invert fg:green) (-invert fg:default)this is(+invert fg:green)  (-invert fg:default)a file(+invert fg:green) 	(-invert fg:default)with(+invert fg:green)  	  (-invert fg:default)whitespace
      (bg:green fg:black)+|(off +invert fg:green) (-invert fg:default)variously(+invert fg:green)  (-invert fg:default)applied
      (bg:green fg:black)+|(off)hg
      (bg:green fg:black)+|(off)across the
      (bg:green fg:black)+|(off)
      (bg:green fg:black)+|(off)
      (bg:green fg:black)+|(off)
      (bg:green fg:black)+|(off)
      (bg:green fg:black)+|(off)
      (bg:green fg:black)+|(off)
      (bg:green fg:black)+|(off)
      (bg:green fg:black)+|(off)
      (bg:green fg:black)+|(off)
      (bg:green fg:black)+|(off)
      (bg:green fg:black)+|(off)lines in an arbitrary
      (bg:green fg:black)+|(off)manner
      "
    `);
  }, 30_000);

  it("intra-line whitespace differences without newline change are ignored", () => {
    writeFileIn(tmp, "prev", "this is a file with whitespace but no newlines\n");
    writeFileIn(tmp, "next", " this is  a file \twith  \t  whitespace    but           no newlines  \n");
    const r = runCli(["-default", "prev", "next"], { cwd: tmp });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  }, 30_000);

  it("python file by extension keeps leading whitespace as significant", () => {
    writeFileIn(tmp, "prev.py", 'print("hello")\n');
    writeFileIn(tmp, "next.py", 'if True:\n  print("hello")\n');
    const r = runCli(["prev.py", "next.py"], { cwd: tmp });
    expect(r.status).toBe(1);
    expect(visibleColors(r.stdout)).toMatchInlineSnapshot(`
      "(fg:red)------ (fg:default +bold)prev.py(-weight)
      (fg:green)++++++ (fg:default +bold)next.py(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,1 +1,2(-weight) ============================================================
      (bg:yellow fg:black)!|(bg:default fg:green)if True:(fg:default)
      (bg:yellow fg:black)!|(bg:default +invert fg:green)  (-invert fg:default)print("hello")
      "
    `);
  }, 30_000);

  it("python file detected via shebang keeps leading whitespace as significant", () => {
    writeFileIn(tmp, "prev", '#!/usr/bin/python\nprint("hello")\n');
    writeFileIn(tmp, "next", '#!/usr/bin/python\nif True:\n  print("hello")\n');
    const r = runCli(["prev", "next"], { cwd: tmp });
    expect(r.status).toBe(1);
    expect(visibleColors(r.stdout)).toMatchInlineSnapshot(`
      "(fg:red)------ (fg:default +bold)prev(-weight)
      (fg:green)++++++ (fg:default +bold)next(-weight)
      (bg:gray fg:black)@|(bg:default fg:default +bold)-1,2 +1,3(-weight) ============================================================
      (bg:gray fg:black) |(bg:default fg:default)#!/usr/bin/python
      (bg:yellow fg:black)!|(bg:default fg:green)if True:(fg:default)
      (bg:yellow fg:black)!|(bg:default +invert fg:green)  (-invert fg:default)print("hello")
      "
    `);
  }, 30_000);
});

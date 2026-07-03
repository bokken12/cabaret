/** Port of OCaml's [patdiff/test/src/test-no-trailing-newline.t]. */

import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkTmpDir, runCli, writeFileIn } from "./_helpers.js";

let tmp: string;

beforeEach(() => {
  tmp = mkTmpDir("patdiff-nl-");
  writeFileIn(tmp, "with_newline", "foo\n");
  writeFileIn(tmp, "missing_newline", "foo");
  writeFileIn(tmp, "extra_newline", "foo\n\n");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("trailing newline handling", () => {
  it("two files with trailing newline: silent", () => {
    const r = runCli(["-default", "with_newline", "with_newline"], { cwd: tmp });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  }, 30_000);

  it("two files missing trailing newline: warn twice", () => {
    const r = runCli(["-default", "missing_newline", "missing_newline"], { cwd: tmp });
    expect(r.status).toBe(0);
    // Per the OCaml test, both files generate a warning. The OCaml prints
    // them to stdout (cram), but [Compare_core.compareFiles] in TS writes
    // them to stderr.
    const out = (r.stdout + r.stderr).trim().split("\n").sort().join("\n");
    expect(out).toMatchInlineSnapshot(`
      "No newline at the end of missing_newline
      No newline at the end of missing_newline"
    `);
  }, 30_000);

  it("two files missing trailing newline, -warn-if-no-trailing-newline-in-both false: silent", () => {
    const r = runCli(
      ["-default", "missing_newline", "missing_newline", "-warn-if-no-trailing-newline-in-both", "false"],
      { cwd: tmp },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  }, 30_000);

  it("one with, one without: warn once for the bad one", () => {
    const r = runCli(["-default", "missing_newline", "with_newline"], { cwd: tmp });
    // Prev "foo" vs next "foo\n" — same content, treated equal? Actually
    // [linesOfContents] gives prev=["foo"], next=["foo"], so diff = none.
    // Exit code 0 expected.
    expect(r.status).toBe(0);
    expect((r.stdout + r.stderr).trim()).toMatchInlineSnapshot(`"No newline at the end of missing_newline"`);
  }, 30_000);

  it("one with, one without, -warn-if-no-trailing-newline-in-both false: still warn", () => {
    const r = runCli(["-default", "missing_newline", "with_newline", "-warn-if-no-trailing-newline-in-both", "false"], {
      cwd: tmp,
    });
    expect(r.status).toBe(0);
    expect((r.stdout + r.stderr).trim()).toMatchInlineSnapshot(`"No newline at the end of missing_newline"`);
  }, 30_000);

  it("missing vs extra newline: still warn the missing", () => {
    const r = runCli(["-default", "missing_newline", "extra_newline"], {
      cwd: tmp,
    });
    // Default config ignores pure-whitespace lines, so the only difference
    // (an extra blank line in [extra_newline]) is filtered out and exit is 0.
    // We still emit the trailing-newline warning.
    expect(r.status).toBe(0);
    expect(r.stderr.trim()).toMatchInlineSnapshot(`"No newline at the end of missing_newline"`);
  }, 30_000);
});

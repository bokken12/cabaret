/** Port of OCaml's [patdiff/test/src/test-files-with-spaces.t]. */

import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkTmpDir, runCli, writeFileIn } from "./_helpers.js";

let tmp: string;

beforeEach(() => {
  tmp = mkTmpDir("patdiff-spaces-");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("files with spaces in names", () => {
  it("normal patdiff", () => {
    writeFileIn(tmp, "prev file", "hello\nworld\n");
    fs.copyFileSync(`${tmp}/prev file`, `${tmp}/next file`);
    const r = runCli(["prev file", "next file"], { cwd: tmp });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  }, 30_000);

  it("-double-check properly quotes the arguments to cmp", () => {
    writeFileIn(tmp, "prev file", "hello\nworld\n");
    fs.copyFileSync(`${tmp}/prev file`, `${tmp}/next file`);
    const r = runCli(["-double-check", "prev file", "next file"], { cwd: tmp });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  }, 30_000);
});

/** Port of OCaml's [patdiff/test/src/test-ascii-output.t]. */

import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkTmpDir, runCli, writeFileIn } from "./_helpers.js";

let tmp: string;

beforeEach(() => {
  tmp = mkTmpDir("patdiff-ascii-");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("ascii output", () => {
  it("no ANSI escapes, no intra-line refinement", () => {
    writeFileIn(tmp, "prev", "hello world\n");
    writeFileIn(tmp, "next", "hello\n");
    const r = runCli(["-default", "prev", "next", "-ascii"], { cwd: tmp });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatchInlineSnapshot(`
      "------ prev
      ++++++ next
      @|-1,1 +1,1 ============================================================
      -|hello world
      +|hello
      "
    `);
  }, 30_000);
});

/** Port of OCaml's [patdiff/test/src/test-html-output.t]. */

import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkTmpDir, runCli, writeFileIn } from "./_helpers.js";

let tmp: string;

beforeEach(() => {
  tmp = mkTmpDir("patdiff-html-");
  writeFileIn(tmp, "prev", "hello world\n");
  writeFileIn(tmp, "next", "hello\n");
  // Set deterministic mtimes (Unix epoch + 1 day).
  fs.utimesSync(`${tmp}/prev`, new Date(0), new Date(0));
  fs.utimesSync(`${tmp}/next`, new Date(86_400_000), new Date(86_400_000));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("html output", () => {
  it("HTML mtimes are displayed in UTC", () => {
    const r = runCli(["-default", "prev", "next", "-html"], {
      cwd: tmp,
      env: { TZ: "America/New_York" },
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatchInlineSnapshot(`
      "<pre style="font-family:consolas,monospace">
      <span style="color:#880000">------ </span><span style="font-weight:bold">prev 1970-01-01 00:00:00.000000Z</span>
      <span style="color:#008800">++++++ </span><span style="font-weight:bold">next 1970-01-02 00:00:00.000000Z</span>
      <span style="color:#000000"><span style="background-color:#c0c0c0">@|</span></span><span style="font-weight:bold">-1,1 +1,1</span> ============================================================
      <span style="color:#000000"><span style="background-color:#888800">!|</span></span>hello<span style="color:#880000"> world</span>
      </pre>
      "
    `);
  }, 30_000);

  it("HTML output respects -alt-prev/-alt-next", () => {
    const r = runCli(["-default", "prev", "next", "-html", "-alt-prev", "a", "-alt-next", "b"], {
      cwd: tmp,
      env: { TZ: "America/New_York" },
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatchInlineSnapshot(`
      "<pre style="font-family:consolas,monospace">
      <span style="color:#880000">------ </span><span style="font-weight:bold">a 1970-01-01 00:00:00.000000Z</span>
      <span style="color:#008800">++++++ </span><span style="font-weight:bold">b 1970-01-02 00:00:00.000000Z</span>
      <span style="color:#000000"><span style="background-color:#c0c0c0">@|</span></span><span style="font-weight:bold">-1,1 +1,1</span> ============================================================
      <span style="color:#000000"><span style="background-color:#888800">!|</span></span>hello<span style="color:#880000"> world</span>
      </pre>
      "
    `);
  }, 30_000);
});

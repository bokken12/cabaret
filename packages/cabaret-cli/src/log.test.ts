import { run } from "@stricli/core";
import { type Backend, parseRefName } from "cabaret-core";
import { expect, test } from "vitest";
import { app } from "./app.js";
import type { LocalContext } from "./context.js";

const LOGS: Record<string, string> = {
  feature: "1748000000 alice set-parent main\n",
  "gadget/v2": '1748000060 bob comment "port of feature"\n1748000120 bob review lib.ts 89abcdef\n',
};

const backend: Backend = {
  currentBranch: async () => parseRefName("feature"),
  readLog: async (change) => LOGS[change] ?? "",
};

/** Run `cabaret <inputs>` against the fake backend, capturing output. */
async function runLog(...inputs: string[]): Promise<{ stdout: string; stderr: string }> {
  const captured = { stdout: "", stderr: "" };
  const capture = (stream: "stdout" | "stderr") => ({
    write(chunk: string): boolean {
      captured[stream] += chunk;
      return true;
    },
  });
  const context: LocalContext = {
    process: { stdout: capture("stdout"), stderr: capture("stderr") },
    backend: async () => backend,
  };
  await run(app, inputs, context);
  return captured;
}

test("log defaults to the current branch's change", async () => {
  expect(await runLog("log")).toEqual({
    stdout: "1748000000 alice set-parent main\n",
    stderr: "",
  });
});

test("log dumps the named change's log verbatim", async () => {
  expect(await runLog("log", "gadget/v2")).toEqual({
    stdout: '1748000060 bob comment "port of feature"\n1748000120 bob review lib.ts 89abcdef\n',
    stderr: "",
  });
});

test("log of a change with no log prints nothing", async () => {
  expect(await runLog("log", "unlogged")).toEqual({ stdout: "", stderr: "" });
});

test("log rejects a malformed change name", async () => {
  const { stdout, stderr } = await runLog("log", "not..a..ref");
  expect(stdout).toBe("");
  expect(stderr).toContain('not a valid ref name: "not..a..ref"');
});

import { ExitCode } from "@stricli/core";
import { expect, test } from "vitest";
import { makeRepo } from "./fixture.js";

test("log defaults to the change of the checked-out branch", async () => {
  const repo = await makeRepo();
  await repo.cabaret("reparent", "main", "trunk");
  expect(await repo.cabaret("log")).toEqual({
    stdout: '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"trunk"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

test("a change with no log has the empty log", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("log", "unlogged")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("rejects a malformed change name", async () => {
  const repo = await makeRepo();
  const result = await repo.cabaret("log", "not..a..ref");
  expect(result.exitCode).toBe(ExitCode.InvalidArgument);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain('not a valid ref name: "not..a..ref"');
});

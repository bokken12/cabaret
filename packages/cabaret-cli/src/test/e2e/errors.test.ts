import { expect, test } from "vitest";
import { makeRepo } from "./fixture.js";

// What each kind of failure looks like to the user. Messages themselves are
// pinned by each command's own tests; these pin the rendering: which failures
// print bare one-line diagnostics, and which keep a stack trace.

test("a user error prints its message bare: no prefix, no stack trace", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("show")).toEqual({
    stdout: "",
    stderr: 'change does not exist: "main"; run `cabaret create` first\n',
    exitCode: 1,
  });
});

test("an argument that fails to parse names the argument and the reason", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("comments", "show", "bad..name")).toEqual({
    stdout: "",
    stderr: 'Failed to parse "bad..name" for change: not a valid ref name: "bad..name"\n',
    exitCode: -4,
  });
});

test("an unknown flag is rejected by name", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("show", "--frobnicate")).toEqual({
    stdout: "",
    stderr: "No flag registered for --frobnicate\n",
    exitCode: -4,
  });
});

test("an unknown command suggests the nearest registered one", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("shwo")).toEqual({
    stdout: "",
    stderr: "No command registered for `shwo`, did you mean `show`?\n",
    exitCode: -5,
  });
});

test("a bug keeps its stack trace", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "feature");
  // The fixture's forge-less context throws a plain Error, standing in for
  // any exception that is not a UserError.
  const result = await repo.cabaret("gh", "pull", "--change", "feature");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/^Command failed, Error: this test repo has no forge\n {4}at /);
});

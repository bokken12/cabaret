import { expect, test } from "vitest";
import { FakeForge } from "./fake-forge.js";
import { makeRepo } from "./fixture.js";

// What each kind of failure looks like to the user. Messages themselves are
// pinned by each command's own tests; these pin the rendering: which failures
// print bare one-line diagnostics, and which keep a stack trace.

test("a user error prints its message bare: no prefix, no stack trace", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("show")).toEqual({
    stdout: "",
    stderr: 'change does not exist: "main"; run `cabaret create`, or `cabaret fetch` to import open forge changes\n',
    exitCode: 1,
  });
});

test("a name the repository's grammar rejects names the reason", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("log", "bad..name")).toEqual({
    stdout: "",
    stderr: 'not a valid branch name: "bad..name"\n',
    exitCode: 1,
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
  // A forge whose credentials check explodes stands in for any exception
  // that is not a UserError.
  const forge = new FakeForge();
  forge.currentSelf = async () => {
    throw new Error("forge exploded");
  };
  const repo = await makeRepo(forge);
  const result = await repo.cabaret("fetch");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/^Command failed, Error: forge exploded\n {4}at /);
});

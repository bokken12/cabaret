import { expect, test } from "vitest";
import { makeRepo } from "./fixture.js";

test("reparent then log round-trips a set-parent entry", async () => {
  const repo = await makeRepo();
  await repo.git("checkout", "-qb", "feature");
  expect(await repo.cabaret("reparent", "feature", "main")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("log", "feature")).toEqual({
    stdout: "1748000000000 alice@example.com set-parent main\n",
    stderr: "",
    exitCode: 0,
  });
});

test("reparent appends to an existing log", async () => {
  const repo = await makeRepo();
  await repo.cabaret("reparent", "gadget", "main");
  await repo.cabaret("reparent", "gadget", "feature/base");
  expect(await repo.cabaret("log", "gadget")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "1748000000000 alice@example.com set-parent main
    1748000000001 alice@example.com set-parent feature/base
    ",
    }
  `);
});

test("reparent fails without a git identity, leaving the log untouched", async () => {
  const repo = await makeRepo();
  await repo.git("config", "--unset", "user.email");
  const result = await repo.cabaret("reparent", "main", "trunk");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("git config user.email");
  expect(await repo.cabaret("log", "main")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("reparent rejects an empty git identity", async () => {
  const repo = await makeRepo();
  await repo.git("config", "user.email", "");
  const result = await repo.cabaret("reparent", "main", "trunk");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("git config user.email must be a single nonempty word");
  expect(await repo.cabaret("log", "main")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

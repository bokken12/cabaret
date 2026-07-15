import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { makeRepo, tempDir } from "./fixture.js";

// Person-level settings write to global config; point it at a writable
// per-test file instead of the fixture-wide /dev/null.
beforeEach(async () => {
  process.env.GIT_CONFIG_GLOBAL = join(await tempDir("cabaret-e2e-global-"), "gitconfig");
});

test("list shows defaults on a fresh repo", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("config", "list")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "alias          (none)
    context        3 (default)
    land-method    merge (default)
    land-via       auto (default)
    rebase-method  merge (default)
    ",
    }
  `);
});

test("a setting shows bare, sets with a value, and clears with --unset", async () => {
  const repo = await makeRepo();
  expect((await repo.cabaret("config", "land-method")).stdout).toBe("merge (default)\n");
  expect(await repo.cabaret("config", "land-method", "squash")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.git("config", "--local", "cabaret.landMethod")).toBe("squash");
  expect((await repo.cabaret("config", "land-method")).stdout).toBe("squash\n");
  expect(await repo.cabaret("config", "land-method", "--unset")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect((await repo.cabaret("config", "land-method")).stdout).toBe("merge (default)\n");
});

test("a person setting writes to global config, replacing the old value", async () => {
  const repo = await makeRepo();
  await repo.cabaret("config", "context", "8");
  await repo.cabaret("config", "context", "-1");
  expect(await repo.git("config", "--global", "--get-all", "cabaret.context")).toBe("-1");
  expect((await repo.cabaret("config", "context")).stdout).toBe("-1\n");
});

test("a bad value is rejected", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("config", "land-via", "carrier-pigeon")).toEqual({
    stdout: "",
    stderr: 'git config cabaret.landVia must be one of local, forge, auto: "carrier-pigeon"\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("config", "context", "many")).toEqual({
    stdout: "",
    stderr: 'context must be a nonnegative integer or -1: "many"\n',
    exitCode: 1,
  });
});

test("a misspelled setting suggests the nearest one", async () => {
  const repo = await makeRepo();
  const { stderr, exitCode } = await repo.cabaret("config", "land-mthod", "squash");
  expect(exitCode).toBe(-5);
  expect(stderr).toContain("land-method");
});

test("a value and --unset together are rejected", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("config", "land-method", "squash", "--unset")).toEqual({
    stdout: "",
    stderr: "pass a value or --unset, not both\n",
    exitCode: 1,
  });
});

test("--unset without a value to unset fails", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("config", "land-via", "--unset")).toEqual({
    stdout: "",
    stderr: "git config cabaret.landVia has no local value\n",
    exitCode: 1,
  });
});

test("aliases are added to and removed from global config", async () => {
  const repo = await makeRepo();
  await repo.cabaret("config", "alias", "add", "agent@example.com");
  expect(await repo.cabaret("config", "alias", "add", "alice@work.example")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("config", "--global", "--get-all", "cabaret.alias")).toBe(
    "agent@example.com\nalice@work.example",
  );
  expect((await repo.cabaret("config", "list")).stdout).toContain(
    "alias          agent@example.com, alice@work.example\n",
  );
  expect(await repo.cabaret("config", "alias", "remove", "agent@example.com")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("config", "--global", "--get-all", "cabaret.alias")).toBe("alice@work.example");
});

test("an added alias widens who counts as you", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "feature", "--owner", "agent@example.com");
  await repo.cabaret("config", "alias", "add", "agent@example.com");
  // Alice may rename the agent's change: the alias makes it hers.
  expect(await repo.cabaret("rename", "feature", "gadget")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("add rejects a duplicate and an empty alias; remove rejects a missing one", async () => {
  const repo = await makeRepo();
  await repo.cabaret("config", "alias", "add", "agent@example.com");
  expect(await repo.cabaret("config", "alias", "add", "agent@example.com")).toEqual({
    stdout: "",
    stderr: 'git config cabaret.alias already contains "agent@example.com" in global config\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("config", "alias", "add", "")).toEqual({
    stdout: "",
    stderr: "alias must be nonempty\n",
    exitCode: 1,
  });
  expect(await repo.cabaret("config", "alias", "remove", "ghost@example.com")).toEqual({
    stdout: "",
    stderr: 'git config cabaret.alias has no global value "ghost@example.com"\n',
    exitCode: 1,
  });
});

test("clear removes every alias", async () => {
  const repo = await makeRepo();
  await repo.cabaret("config", "alias", "add", "agent@example.com");
  await repo.cabaret("config", "alias", "add", "alice@work.example");
  expect(await repo.cabaret("config", "alias", "clear")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect((await repo.cabaret("config", "list")).stdout).toContain("alias          (none)\n");
});

test("--global and --local override a setting's home scope", async () => {
  const repo = await makeRepo();
  await repo.cabaret("config", "land-method", "squash", "--global");
  expect(await repo.git("config", "--global", "cabaret.landMethod")).toBe("squash");
  await repo.cabaret("config", "alias", "add", "agent@example.com", "--local");
  expect(await repo.git("config", "--local", "--get-all", "cabaret.alias")).toBe("agent@example.com");
  // The same value may live in both scopes: each is checked and removed alone.
  await repo.cabaret("config", "alias", "add", "agent@example.com");
  expect(await repo.cabaret("config", "alias", "remove", "agent@example.com", "--local")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("config", "--global", "--get-all", "cabaret.alias")).toBe("agent@example.com");
  // Unsetting where nothing is set reports the scope it looked in.
  expect(await repo.cabaret("config", "land-method", "--unset", "--local")).toEqual({
    stdout: "",
    stderr: "git config cabaret.landMethod has no local value\n",
    exitCode: 1,
  });
});

test("a bare setting and list read one scope with --global or --local", async () => {
  const repo = await makeRepo();
  await repo.cabaret("config", "land-method", "squash");
  await repo.cabaret("config", "alias", "add", "agent@example.com");
  expect((await repo.cabaret("config", "land-method", "--global")).stdout).toBe("(unset)\n");
  expect((await repo.cabaret("config", "list", "--global")).stdout).toMatchInlineSnapshot(`
    "alias          agent@example.com
    context        (unset)
    land-method    (unset)
    land-via       (unset)
    rebase-method  (unset)
    "
  `);
  expect((await repo.cabaret("config", "list", "--local")).stdout).toMatchInlineSnapshot(`
    "alias          (unset)
    context        (unset)
    land-method    squash
    land-via       (unset)
    rebase-method  (unset)
    "
  `);
});

test("--global and --local exclude each other", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("config", "context", "8", "--global", "--local")).toEqual({
    stdout: "",
    stderr: "pass at most one of --global and --local\n",
    exitCode: 1,
  });
});

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
      "stdout": "alias        (none)
    context      3 (default)
    land-method  merge (default)
    land-via     auto (default)
    ",
    }
  `);
});

test("set and unset a repository setting", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("config", "set", "land-method", "squash")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("config", "--local", "cabaret.landMethod")).toBe("squash");
  expect((await repo.cabaret("config", "list")).stdout).toContain("land-method  squash\n");
  expect(await repo.cabaret("config", "unset", "land-method")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect((await repo.cabaret("config", "list")).stdout).toContain("land-method  merge (default)\n");
});

test("set writes a person setting to global config, replacing the old value", async () => {
  const repo = await makeRepo();
  await repo.cabaret("config", "set", "context", "8");
  await repo.cabaret("config", "set", "context", "-1");
  expect(await repo.git("config", "--global", "--get-all", "cabaret.context")).toBe("-1");
  expect((await repo.cabaret("config", "list")).stdout).toContain("context      -1\n");
});

test("set rejects a bad value", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("config", "set", "land-via", "carrier-pigeon")).toEqual({
    stdout: "",
    stderr: 'git config cabaret.landVia must be one of local, forge, auto: "carrier-pigeon"\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("config", "set", "context", "many")).toEqual({
    stdout: "",
    stderr: 'context must be a nonnegative integer or -1: "many"\n',
    exitCode: 1,
  });
});

test("set rejects an unknown setting", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("config", "set", "land-mthod", "squash")).toEqual({
    stdout: "",
    stderr:
      'Failed to parse "land-mthod" for setting: unknown setting: "land-mthod" ' +
      "(expected one of alias, context, land-method, land-via)\n",
    exitCode: -4,
  });
});

test("unset without a value to unset fails", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("config", "unset", "land-via")).toEqual({
    stdout: "",
    stderr: "git config cabaret.landVia has no local value\n",
    exitCode: 1,
  });
});

test("add and remove aliases in global config", async () => {
  const repo = await makeRepo();
  await repo.cabaret("config", "add", "alias", "agent@example.com");
  expect(await repo.cabaret("config", "add", "alias", "alice@work.example")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("config", "--global", "--get-all", "cabaret.alias")).toBe(
    "agent@example.com\nalice@work.example",
  );
  expect((await repo.cabaret("config", "list")).stdout).toContain(
    "alias        agent@example.com, alice@work.example\n",
  );
  expect(await repo.cabaret("config", "remove", "alias", "agent@example.com")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("config", "--global", "--get-all", "cabaret.alias")).toBe("alice@work.example");
});

test("an added alias widens who counts as you", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "feature", "--owner", "agent@example.com");
  await repo.cabaret("config", "add", "alias", "agent@example.com");
  // Alice may rename the agent's change: the alias makes it hers.
  expect(await repo.cabaret("rename", "feature", "gadget")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("add rejects a duplicate, an empty alias, and unset rejects when no aliases exist", async () => {
  const repo = await makeRepo();
  await repo.cabaret("config", "add", "alias", "agent@example.com");
  expect(await repo.cabaret("config", "add", "alias", "agent@example.com")).toEqual({
    stdout: "",
    stderr: 'git config cabaret.alias already contains "agent@example.com" in global config\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("config", "add", "alias", "")).toEqual({
    stdout: "",
    stderr: "alias must be nonempty\n",
    exitCode: 1,
  });
  expect(await repo.cabaret("config", "remove", "alias", "ghost@example.com")).toEqual({
    stdout: "",
    stderr: 'git config cabaret.alias has no global value "ghost@example.com"\n',
    exitCode: 1,
  });
});

test("set, unset, add, and remove insist on the right arity of setting", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("config", "set", "alias", "agent@example.com")).toEqual({
    stdout: "",
    stderr: "alias holds multiple values; use `cabaret config add alias`\n",
    exitCode: 1,
  });
  expect(await repo.cabaret("config", "add", "land-method", "squash")).toEqual({
    stdout: "",
    stderr: "land-method holds one value; use `cabaret config set land-method`\n",
    exitCode: 1,
  });
  expect(await repo.cabaret("config", "remove", "land-method", "squash")).toEqual({
    stdout: "",
    stderr: "land-method holds one value; use `cabaret config unset land-method`\n",
    exitCode: 1,
  });
});

test("--global and --local override a setting's home scope", async () => {
  const repo = await makeRepo();
  await repo.cabaret("config", "set", "land-method", "squash", "--global");
  expect(await repo.git("config", "--global", "cabaret.landMethod")).toBe("squash");
  await repo.cabaret("config", "add", "alias", "agent@example.com", "--local");
  expect(await repo.git("config", "--local", "--get-all", "cabaret.alias")).toBe("agent@example.com");
  // The same value may live in both scopes: each is checked and removed alone.
  await repo.cabaret("config", "add", "alias", "agent@example.com");
  expect(await repo.cabaret("config", "remove", "alias", "agent@example.com", "--local")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("config", "--global", "--get-all", "cabaret.alias")).toBe("agent@example.com");
  // Unsetting where nothing is set reports the scope it looked in.
  expect(await repo.cabaret("config", "unset", "land-method", "--local")).toEqual({
    stdout: "",
    stderr: "git config cabaret.landMethod has no local value\n",
    exitCode: 1,
  });
});

test("list reads one scope with --global or --local", async () => {
  const repo = await makeRepo();
  await repo.cabaret("config", "set", "land-method", "squash");
  await repo.cabaret("config", "add", "alias", "agent@example.com");
  expect((await repo.cabaret("config", "list", "--global")).stdout).toMatchInlineSnapshot(`
    "alias        agent@example.com
    context      (unset)
    land-method  (unset)
    land-via     (unset)
    "
  `);
  expect((await repo.cabaret("config", "list", "--local")).stdout).toMatchInlineSnapshot(`
    "alias        (unset)
    context      (unset)
    land-method  squash
    land-via     (unset)
    "
  `);
});

test("--global and --local exclude each other", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("config", "set", "context", "8", "--global", "--local")).toEqual({
    stdout: "",
    stderr: "pass at most one of --global and --local\n",
    exitCode: 1,
  });
});

test("unset clears every alias", async () => {
  const repo = await makeRepo();
  await repo.cabaret("config", "add", "alias", "agent@example.com");
  await repo.cabaret("config", "add", "alias", "alice@work.example");
  expect(await repo.cabaret("config", "unset", "alias")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect((await repo.cabaret("config", "list")).stdout).toContain("alias        (none)\n");
});

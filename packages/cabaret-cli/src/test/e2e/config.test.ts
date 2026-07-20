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
      "stdout": "alias            (none)
    context          3 (default)
    land-method      merge (default)
    land-via         auto (default)
    workspace-style  shared (default)
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
    stderr: 'config cabaret.landVia must be one of local, forge, auto: "carrier-pigeon"\n',
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
    stderr: "config cabaret.landVia has no local value\n",
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
    "alias            agent@example.com, alice@work.example\n",
  );
  expect(await repo.cabaret("config", "alias", "remove", "agent@example.com")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("config", "--global", "--get-all", "cabaret.alias")).toBe("alice@work.example");
});

test("alias bare and show print the current values", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("config", "alias")).toEqual({ stdout: "(none)\n", stderr: "", exitCode: 0 });
  await repo.cabaret("config", "alias", "add", "agent@example.com");
  await repo.cabaret("config", "alias", "add", "alice@work.example");
  expect((await repo.cabaret("config", "alias")).stdout).toBe("agent@example.com, alice@work.example\n");
  expect((await repo.cabaret("config", "alias", "show")).stdout).toBe("agent@example.com, alice@work.example\n");
  expect((await repo.cabaret("config", "alias", "--local")).stdout).toBe("(unset)\n");
});

test("a forge's show prints its accounts bare", async () => {
  const repo = await makeRepo();
  await repo.cabaret("config", "alias", "add", "agent@example.com");
  await repo.cabaret("config", "alias", "github", "add", "alice");
  await repo.cabaret("config", "alias", "github", "add", "alice-work");
  await repo.cabaret("config", "alias", "codeberg", "add", "wanderer");
  expect(await repo.cabaret("config", "alias", "github")).toEqual({
    stdout: "alice, alice-work\n",
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("config", "alias", "github", "show")).stdout).toBe("alice, alice-work\n");
  expect((await repo.cabaret("config", "alias", "gitlab")).stdout).toBe("(none)\n");
  expect((await repo.cabaret("config", "alias", "codeberg", "--local")).stdout).toBe("(unset)\n");
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
    stderr: 'config cabaret.alias already contains "agent@example.com" in global config\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("config", "alias", "add", "")).toEqual({
    stdout: "",
    stderr: "alias must be nonempty\n",
    exitCode: 1,
  });
  expect(await repo.cabaret("config", "alias", "remove", "ghost@example.com")).toEqual({
    stdout: "",
    stderr: 'config cabaret.alias has no global value "ghost@example.com"\n',
    exitCode: 1,
  });
});

test("clear removes every alias", async () => {
  const repo = await makeRepo();
  await repo.cabaret("config", "alias", "add", "agent@example.com");
  await repo.cabaret("config", "alias", "add", "alice@work.example");
  expect(await repo.cabaret("config", "alias", "clear")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect((await repo.cabaret("config", "list")).stdout).toContain("alias            (none)\n");
});

test("a forge's alias subcommands take bare account names and store them under its scheme", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("config", "alias", "github", "add", "alice")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  await repo.cabaret("config", "alias", "gitlab", "add", "alice");
  await repo.cabaret("config", "alias", "codeberg", "add", "wanderer");
  expect(await repo.git("config", "--global", "--get-all", "cabaret.alias")).toBe(
    "github:alice\ngitlab:alice\ncodeberg:wanderer",
  );
  expect(await repo.cabaret("config", "alias", "github", "remove", "alice")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("config", "--global", "--get-all", "cabaret.alias")).toBe("gitlab:alice\ncodeberg:wanderer");
});

test("a forge alias rejects an email, a schemed identity, and a duplicate", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("config", "alias", "github", "add", "alice@example.com")).toEqual({
    stdout: "",
    stderr: "pass the bare account name, e.g. `cab config alias github add alice`\n",
    exitCode: 1,
  });
  expect((await repo.cabaret("config", "alias", "gitlab", "add", "gitlab:alice")).stderr).toBe(
    "pass the bare account name, e.g. `cab config alias gitlab add alice`\n",
  );
  await repo.cabaret("config", "alias", "github", "add", "alice");
  expect(await repo.cabaret("config", "alias", "github", "add", "alice")).toEqual({
    stdout: "",
    stderr: 'git config cabaret.alias already contains "github:alice" in global config\n',
    exitCode: 1,
  });
});

test("a forge's clear removes only that forge's accounts", async () => {
  const repo = await makeRepo();
  await repo.cabaret("config", "alias", "add", "agent@example.com");
  await repo.cabaret("config", "alias", "github", "add", "alice");
  await repo.cabaret("config", "alias", "github", "add", "alice-work");
  await repo.cabaret("config", "alias", "codeberg", "add", "alice");
  expect(await repo.cabaret("config", "alias", "github", "clear")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.git("config", "--global", "--get-all", "cabaret.alias")).toBe("agent@example.com\ncodeberg:alice");
  expect(await repo.cabaret("config", "alias", "github", "clear")).toEqual({
    stdout: "",
    stderr: "git config cabaret.alias has no global github accounts\n",
    exitCode: 1,
  });
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
    stderr: "config cabaret.landMethod has no local value\n",
    exitCode: 1,
  });
});

test("a bare setting and list read one scope with --global or --local", async () => {
  const repo = await makeRepo();
  await repo.cabaret("config", "land-method", "squash");
  await repo.cabaret("config", "alias", "add", "agent@example.com");
  expect((await repo.cabaret("config", "land-method", "--global")).stdout).toBe("(unset)\n");
  expect((await repo.cabaret("config", "list", "--global")).stdout).toMatchInlineSnapshot(`
    "alias            agent@example.com
    context          (unset)
    land-method      (unset)
    land-via         (unset)
    workspace-style  (unset)
    "
  `);
  expect((await repo.cabaret("config", "list", "--local")).stdout).toMatchInlineSnapshot(`
    "alias            (unset)
    context          (unset)
    land-method      squash
    land-via         (unset)
    workspace-style  (unset)
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

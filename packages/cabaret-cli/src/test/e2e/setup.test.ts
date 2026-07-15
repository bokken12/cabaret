import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { makeRepo, tempDir } from "./fixture.js";

// The person-level recommendations write to global config; point it at a
// writable per-test file instead of the fixture-wide /dev/null.
beforeEach(async () => {
  process.env.GIT_CONFIG_GLOBAL = join(await tempDir("cabaret-e2e-global-"), "gitconfig");
});

test("list shows every recommendation unset on a fresh repo", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("setup", "list")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "merge.conflictStyle  zdiff3 (unset)
    rerere.enabled       true (unset)
    remote.origin.fetch  +refs/cabaret/log/*:refs/cabaret/remote-log/* (unset)
    ",
    }
  `);
});

test("apply sets the unset recommendations and then has nothing to do", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("setup", "apply")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "set merge.conflictStyle = zdiff3
    set rerere.enabled = true
    added remote.origin.fetch = +refs/cabaret/log/*:refs/cabaret/remote-log/*
    ",
    }
  `);
  expect(await repo.git("config", "--global", "merge.conflictStyle")).toBe("zdiff3");
  expect(await repo.git("config", "--global", "rerere.enabled")).toBe("true");
  expect(await repo.git("config", "--local", "--get-all", "remote.origin.fetch")).toBe(
    "+refs/heads/*:refs/remotes/origin/*\n+refs/cabaret/log/*:refs/cabaret/remote-log/*",
  );
  expect(await repo.cabaret("setup", "list")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "merge.conflictStyle  zdiff3
    rerere.enabled       true
    remote.origin.fetch  +refs/cabaret/log/*:refs/cabaret/remote-log/*
    ",
    }
  `);
  expect(await repo.cabaret("setup", "apply")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "nothing to apply
    ",
    }
  `);
});

test("a key set to another value is kept, not overwritten", async () => {
  const repo = await makeRepo();
  await repo.git("config", "--global", "merge.conflictStyle", "diff3");
  expect(await repo.cabaret("setup", "apply")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "kept merge.conflictStyle = diff3
    set rerere.enabled = true
    added remote.origin.fetch = +refs/cabaret/log/*:refs/cabaret/remote-log/*
    ",
    }
  `);
  expect(await repo.git("config", "--global", "merge.conflictStyle")).toBe("diff3");
  expect((await repo.cabaret("setup", "list")).stdout).toMatchInlineSnapshot(`
    "merge.conflictStyle  diff3 (differs from zdiff3)
    rerere.enabled       true
    remote.origin.fetch  +refs/cabaret/log/*:refs/cabaret/remote-log/*
    "
  `);
});

test("list marks a declined scope; apply applies it anyway", async () => {
  const repo = await makeRepo();
  await repo.git("config", "--local", "cabaret.setupDeclined", "true");
  expect((await repo.cabaret("setup", "list")).stdout).toMatchInlineSnapshot(`
    "merge.conflictStyle  zdiff3 (unset)
    rerere.enabled       true (unset)
    remote.origin.fetch  +refs/cabaret/log/*:refs/cabaret/remote-log/* (unset, declined)
    "
  `);
  await repo.cabaret("setup", "apply");
  expect(await repo.git("config", "--local", "--get-all", "remote.origin.fetch")).toBe(
    "+refs/heads/*:refs/remotes/origin/*\n+refs/cabaret/log/*:refs/cabaret/remote-log/*",
  );
});

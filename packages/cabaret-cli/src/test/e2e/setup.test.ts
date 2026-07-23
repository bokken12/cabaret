import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { FakeForge } from "./fake-forge.js";
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
      "stdout": "merge.conflictStyle     zdiff3 (unset)
    rerere.enabled          true (unset)
    remote.origin.fetch     +refs/cabaret/log/*:refs/cabaret/remote-log/* (unset)
    core.commitGraph        true (unset)
    fetch.writeCommitGraph  true (unset)
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
    set core.commitGraph = true
    set fetch.writeCommitGraph = true
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
      "stdout": "merge.conflictStyle     zdiff3
    rerere.enabled          true
    remote.origin.fetch     +refs/cabaret/log/*:refs/cabaret/remote-log/*
    core.commitGraph        true
    fetch.writeCommitGraph  true
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
    set core.commitGraph = true
    set fetch.writeCommitGraph = true
    ",
    }
  `);
  expect(await repo.git("config", "--global", "merge.conflictStyle")).toBe("diff3");
  expect((await repo.cabaret("setup", "list")).stdout).toMatchInlineSnapshot(`
    "merge.conflictStyle     diff3 (differs from zdiff3)
    rerere.enabled          true
    remote.origin.fetch     +refs/cabaret/log/*:refs/cabaret/remote-log/*
    core.commitGraph        true
    fetch.writeCommitGraph  true
    "
  `);
});

test("list marks a declined scope; apply applies it anyway", async () => {
  const repo = await makeRepo();
  await repo.git("config", "--local", "cabaret.setupDeclined", "true");
  expect((await repo.cabaret("setup", "list")).stdout).toMatchInlineSnapshot(`
    "merge.conflictStyle     zdiff3 (unset)
    rerere.enabled          true (unset)
    remote.origin.fetch     +refs/cabaret/log/*:refs/cabaret/remote-log/* (unset, declined)
    core.commitGraph        true (unset)
    fetch.writeCommitGraph  true (unset)
    "
  `);
  await repo.cabaret("setup", "apply");
  expect(await repo.git("config", "--local", "--get-all", "remote.origin.fetch")).toBe(
    "+refs/heads/*:refs/remotes/origin/*\n+refs/cabaret/log/*:refs/cabaret/remote-log/*",
  );
});

test("a signed-in forge recommends aliasing its account and profile emails", async () => {
  const forge = new FakeForge();
  forge.tokenEmail = "alice@corp.example.com";
  const repo = await makeRepo(forge);
  expect((await repo.cabaret("setup", "list")).stdout).toMatchInlineSnapshot(`
    "merge.conflictStyle     zdiff3 (unset)
    rerere.enabled          true (unset)
    remote.origin.fetch     +refs/cabaret/log/*:refs/cabaret/remote-log/* (unset)
    core.commitGraph        true (unset)
    fetch.writeCommitGraph  true (unset)
    cabaret.alias           github:alice (unset)
    cabaret.alias           alice@corp.example.com (unset)
    "
  `);
  expect(await repo.cabaret("setup", "apply")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "set merge.conflictStyle = zdiff3
    set rerere.enabled = true
    added remote.origin.fetch = +refs/cabaret/log/*:refs/cabaret/remote-log/*
    set core.commitGraph = true
    set fetch.writeCommitGraph = true
    added cabaret.alias = github:alice
    added cabaret.alias = alice@corp.example.com
    ",
    }
  `);
  expect(await repo.git("config", "--local", "--get-all", "cabaret.alias")).toBe(
    "github:alice\nalice@corp.example.com",
  );
  // Applied aliases count as the current user, so nothing is left to recommend.
  expect((await repo.cabaret("setup", "list")).stdout).toMatchInlineSnapshot(`
    "merge.conflictStyle     zdiff3
    rerere.enabled          true
    remote.origin.fetch     +refs/cabaret/log/*:refs/cabaret/remote-log/*
    core.commitGraph        true
    fetch.writeCommitGraph  true
    "
  `);
});

test("an alias already declared is not re-recommended", async () => {
  const repo = await makeRepo(new FakeForge());
  await repo.cabaret("config", "alias", "github", "add", "alice");
  expect((await repo.cabaret("setup", "list")).stdout).toMatchInlineSnapshot(`
    "merge.conflictStyle     zdiff3 (unset)
    rerere.enabled          true (unset)
    remote.origin.fetch     +refs/cabaret/log/*:refs/cabaret/remote-log/* (unset)
    core.commitGraph        true (unset)
    fetch.writeCommitGraph  true (unset)
    "
  `);
});

import { expect, test } from "vitest";
import { makeClone, makeRepo } from "./fixture.js";

test("reparent appends a set-parent entry to the change's log", async () => {
  const repo = await makeRepo();
  const root = await repo.git("rev-parse", "main");
  await repo.git("branch", "trunk");
  await repo.cabaret("create", "feature");
  expect(await repo.cabaret("reparent", "feature", "trunk")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("log", "feature")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${root}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      '{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-parent","parent":"trunk"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

test("reparent accepts a parent held only at origin", async () => {
  const repo = await makeRepo();
  const root = await repo.git("rev-parse", "main");
  await repo.git("push", "-q", "origin", "main");
  await repo.cabaret("create", "feature");
  // A second machine publishes a branch this clone has fetched but never
  // checked out.
  const other = await makeClone(repo, "bob@example.com");
  await other.git("checkout", "-qb", "trunk");
  await other.write("trunk.txt", "trunk work\n");
  await other.git("add", "-A");
  await other.git("commit", "-qm", "trunk work");
  await other.git("push", "-q", "origin", "trunk");
  await repo.git("fetch", "-q", "origin");
  expect(await repo.cabaret("reparent", "feature", "trunk")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("log", "feature")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${root}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      '{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-parent","parent":"trunk"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

test("reparent onto a branch that does not exist fails, leaving the log untouched", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "feature");
  const before = await repo.cabaret("log", "feature");
  expect(await repo.cabaret("reparent", "feature", "trunk")).toEqual({
    stdout: "",
    stderr: 'parent branch does not exist: "trunk"\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("log", "feature")).toEqual(before);
});

test("reparent onto the change itself fails, leaving the log untouched", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "feature");
  const before = await repo.cabaret("log", "feature");
  expect(await repo.cabaret("reparent", "feature", "feature")).toEqual({
    stdout: "",
    stderr: 'change cannot be its own parent: "feature"\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("log", "feature")).toEqual(before);
});

test("reparent fails without a git identity, leaving the log untouched", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "feature");
  const before = await repo.cabaret("log", "feature");
  await repo.git("config", "--unset", "user.email");
  expect(await repo.cabaret("reparent", "feature", "trunk")).toEqual({
    stdout: "",
    stderr: "git config user.email is not set; log entries need an identity\n",
    exitCode: 1,
  });
  expect(await repo.cabaret("log", "feature")).toEqual(before);
});

test("reparent rejects an empty git identity", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "feature");
  const before = await repo.cabaret("log", "feature");
  await repo.git("config", "user.email", "");
  expect(await repo.cabaret("reparent", "feature", "trunk")).toEqual({
    stdout: "",
    stderr: "git config user.email must be nonempty\n",
    exitCode: 1,
  });
  expect(await repo.cabaret("log", "feature")).toEqual(before);
});

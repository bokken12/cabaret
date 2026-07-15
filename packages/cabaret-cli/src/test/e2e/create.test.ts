import { expect, test } from "vitest";
import { makeRepo } from "./fixture.js";

test("create makes a new branch at the parent's tip and initializes its log", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("create", "feature")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  const tip = await repo.git("rev-parse", "main");
  expect(await repo.git("rev-parse", "feature")).toBe(tip);
  // The current branch is adopted as the parent, not switched away from.
  expect(await repo.git("symbolic-ref", "--short", "HEAD")).toBe("main");
  expect(await repo.cabaret("log", "feature")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${tip}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

test("create adopts an existing branch, based where it left the parent", async () => {
  const repo = await makeRepo();
  const root = await repo.git("rev-parse", "main");
  await repo.git("branch", "trunk");
  await repo.write("feature.txt", "work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "feature work");
  expect(await repo.cabaret("create", "main", "--parent", "trunk")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("log", "main")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"trunk"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${root}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

test("create --owner records the given owner instead of the creator", async () => {
  const repo = await makeRepo();
  const tip = await repo.git("rev-parse", "main");
  expect(await repo.cabaret("create", "feature", "--owner", "bob@example.com")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("log", "feature")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${tip}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"bob@example.com"}}\n' +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

test("create fails when the change already exists", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "feature");
  const before = await repo.cabaret("log", "feature");
  expect(await repo.cabaret("create", "feature")).toEqual({
    stdout: "",
    stderr: 'change already exists: "feature"\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("log", "feature")).toEqual(before);
});

test("create fails when the parent branch does not exist, creating nothing", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("create", "feature", "--parent", "ghost")).toEqual({
    stdout: "",
    stderr: 'parent branch does not exist: "ghost"\n',
    exitCode: 1,
  });
  expect(await repo.git("branch", "--list", "feature")).toBe("");
  expect(await repo.cabaret("log", "feature")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("create fails without a git identity, leaving no branch behind", async () => {
  const repo = await makeRepo();
  await repo.git("config", "--unset", "user.email");
  expect(await repo.cabaret("create", "feature")).toEqual({
    stdout: "",
    stderr: "git config user.email is not set; log entries need an identity\n",
    exitCode: 1,
  });
  expect(await repo.git("branch", "--list", "feature")).toBe("");
});

test("create rejects a change that is its own parent", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("create", "main")).toEqual({
    stdout: "",
    stderr: 'change cannot be its own parent: "main"\n',
    exitCode: 1,
  });
});

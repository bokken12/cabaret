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
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n',
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
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n',
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
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"bob@example.com"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

test("create fails when the change already has a log", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "feature");
  const before = await repo.cabaret("log", "feature");
  const result = await repo.cabaret("create", "feature");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('change already has a log: "feature"');
  expect(await repo.cabaret("log", "feature")).toEqual(before);
});

test("create fails when the parent branch does not exist, creating nothing", async () => {
  const repo = await makeRepo();
  const result = await repo.cabaret("create", "feature", "--parent", "ghost");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('parent branch does not exist: "ghost"');
  expect(await repo.git("branch", "--list", "feature")).toBe("");
  expect(await repo.cabaret("log", "feature")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("create fails without a git identity, leaving no branch behind", async () => {
  const repo = await makeRepo();
  await repo.git("config", "--unset", "user.email");
  const result = await repo.cabaret("create", "feature");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("git config user.email");
  expect(await repo.git("branch", "--list", "feature")).toBe("");
});

test("create rejects a change that is its own parent", async () => {
  const repo = await makeRepo();
  const result = await repo.cabaret("create", "main");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('change cannot be its own parent: "main"');
});

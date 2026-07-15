import { ExitCode } from "@stricli/core";
import { expect, test } from "vitest";
import { makeRepo } from "./fixture.js";

test("review marks files at the current change's tip", async () => {
  const repo = await makeRepo();
  const head = await repo.git("rev-parse", "main");
  await repo.git("branch", "trunk");
  await repo.cabaret("create", "main", "--parent", "trunk");
  expect(await repo.cabaret("review", "src/a.ts", "src/b.ts")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("log")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"trunk"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${head}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      `{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"review","file":"src/a.ts","base":"${head}","tip":"${head}"}}\n` +
      `{"timestamp":1748000000005,"user":"alice@example.com","action":{"kind":"review","file":"src/b.ts","base":"${head}","tip":"${head}"}}\n`,
    stderr: "",
    exitCode: 0,
  });
});

test("review records the base where the change forked from its parent", async () => {
  const repo = await makeRepo();
  const root = await repo.git("rev-parse", "main");
  await repo.git("checkout", "-qb", "feature");
  await repo.git("commit", "-qm", "feature work", "--allow-empty");
  const tip = await repo.git("rev-parse", "feature");
  await repo.git("checkout", "-q", "main");
  await repo.git("commit", "-qm", "main work", "--allow-empty");
  await repo.cabaret("create", "feature", "--parent", "main");
  expect(await repo.cabaret("review", "--change", "feature", "lib/core.ts")).toEqual({
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
      `{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"review","file":"lib/core.ts","base":"${root}","tip":"${tip}"}}\n`,
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("log", "main")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("review --tip resolves a symbolic revision to a full hash", async () => {
  const repo = await makeRepo();
  const root = await repo.git("rev-parse", "main");
  await repo.git("branch", "trunk");
  await repo.git("commit", "-qm", "tip", "--allow-empty");
  await repo.cabaret("create", "main", "--parent", "trunk");
  expect(await repo.cabaret("review", "--tip", "HEAD^", "docs/notes.md")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("log")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"trunk"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${root}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      `{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"review","file":"docs/notes.md","base":"${root}","tip":"${root}"}}\n`,
    stderr: "",
    exitCode: 0,
  });
});

test("review defaults to the change's branch even when a tag shadows its name", async () => {
  const repo = await makeRepo();
  const root = await repo.git("rev-parse", "main");
  await repo.git("branch", "gadget");
  await repo.git("commit", "-qm", "advance main", "--allow-empty");
  await repo.git("tag", "gadget", "main");
  await repo.cabaret("create", "gadget", "--parent", "main");
  expect(await repo.cabaret("review", "--change", "gadget", "src/a.ts")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("log", "gadget")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${root}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      `{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"review","file":"src/a.ts","base":"${root}","tip":"${root}"}}\n`,
    stderr: "",
    exitCode: 0,
  });
});

test("review fails on an unknown tip revision, leaving the log untouched", async () => {
  const repo = await makeRepo();
  const root = await repo.git("rev-parse", "main");
  await repo.git("branch", "trunk");
  await repo.cabaret("create", "main", "--parent", "trunk");
  expect(await repo.cabaret("review", "--tip", "no-such-rev", "src/a.ts")).toEqual({
    stdout: "",
    stderr: 'unknown revision: "no-such-rev"\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("log")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"trunk"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${root}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

test("review fails on a change that does not exist, leaving the log untouched", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("review", "src/a.ts")).toEqual({
    stdout: "",
    stderr: 'change does not exist: "main"; run `cabaret create`, or `cabaret pull` to import open forge changes\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("log")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("review requires at least one file", async () => {
  const repo = await makeRepo();
  const result = await repo.cabaret("review");
  expect(result.exitCode).toBe(ExitCode.InvalidArgument);
  expect(await repo.cabaret("log")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

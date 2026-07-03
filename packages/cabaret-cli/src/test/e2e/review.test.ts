import { ExitCode } from "@stricli/core";
import { expect, test } from "vitest";
import { makeRepo } from "./fixture.js";

test("review marks files at the current change's tip", async () => {
  const repo = await makeRepo();
  const head = await repo.git("rev-parse", "main");
  expect(await repo.cabaret("review", "src/a.ts", "src/b.ts")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("log")).toEqual({
    stdout:
      `{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"review","file":"src/a.ts","revision":"${head}"}}\n` +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"review","file":"src/b.ts","revision":"${head}"}}\n`,
    stderr: "",
    exitCode: 0,
  });
});

test("review --change marks at that change's tip, not the checked-out one", async () => {
  const repo = await makeRepo();
  const root = await repo.git("rev-parse", "main");
  await repo.git("branch", "feature");
  await repo.git("commit", "-qm", "advance main", "--allow-empty");
  expect(await repo.cabaret("review", "--change", "feature", "lib/core.ts")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("log", "feature")).toEqual({
    stdout: `{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"review","file":"lib/core.ts","revision":"${root}"}}\n`,
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("log", "main")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("review --revision resolves a symbolic revision to a full hash", async () => {
  const repo = await makeRepo();
  const root = await repo.git("rev-parse", "main");
  await repo.git("commit", "-qm", "tip", "--allow-empty");
  expect(await repo.cabaret("review", "--revision", "HEAD^", "docs/notes.md")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("log")).toEqual({
    stdout: `{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"review","file":"docs/notes.md","revision":"${root}"}}\n`,
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
  expect(await repo.cabaret("review", "--change", "gadget", "src/a.ts")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("log", "gadget")).toEqual({
    stdout: `{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"review","file":"src/a.ts","revision":"${root}"}}\n`,
    stderr: "",
    exitCode: 0,
  });
});

test("review fails on an unknown revision, leaving the log untouched", async () => {
  const repo = await makeRepo();
  const result = await repo.cabaret("review", "--revision", "no-such-rev", "src/a.ts");
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain('unknown revision: "no-such-rev"');
  expect(await repo.cabaret("log")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("review requires at least one file", async () => {
  const repo = await makeRepo();
  const result = await repo.cabaret("review");
  expect(result.exitCode).toBe(ExitCode.InvalidArgument);
  expect(await repo.cabaret("log")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

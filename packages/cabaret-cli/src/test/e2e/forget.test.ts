import { ExitCode } from "@stricli/core";
import { expect, test } from "vitest";
import { makeRepo } from "./fixture.js";

test("forget appends a forget entry after a review", async () => {
  const repo = await makeRepo();
  const head = await repo.git("rev-parse", "main");
  await repo.git("branch", "trunk");
  await repo.cabaret("create", "main", "--parent", "trunk");
  await repo.cabaret("review", "src/a.ts");
  expect(await repo.cabaret("forget", "src/a.ts")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("log")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"trunk"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${head}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      `{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"review","file":"src/a.ts","base":"${head}","tip":"${head}"}}\n` +
      '{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"forget","file":"src/a.ts"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

test("forget --change writes one entry per file to that change's log", async () => {
  const repo = await makeRepo();
  const root = await repo.git("rev-parse", "main");
  await repo.cabaret("create", "gadget");
  expect(await repo.cabaret("forget", "--change", "gadget", "lib/core.ts", "docs/notes.md")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("log", "gadget")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${root}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"forget","file":"lib/core.ts"}}\n' +
      '{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"forget","file":"docs/notes.md"}}\n',
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("log", "main")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("forget fails on a change that does not exist", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("forget", "--change", "gadget", "lib/core.ts")).toEqual({
    stdout: "",
    stderr:
      'change does not exist: "gadget"; run `cabaret create`, or `cabaret gh pull` to import open forge changes\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("log", "gadget")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("forget requires at least one file", async () => {
  const repo = await makeRepo();
  const result = await repo.cabaret("forget");
  expect(result.exitCode).toBe(ExitCode.InvalidArgument);
  expect(await repo.cabaret("log")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

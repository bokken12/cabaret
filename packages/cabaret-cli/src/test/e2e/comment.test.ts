import { ExitCode } from "@stricli/core";
import { expect, test } from "vitest";
import { makeRepo } from "./fixture.js";

test("comment appends a comment entry to the current change's log", async () => {
  const repo = await makeRepo();
  const head = await repo.git("rev-parse", "main");
  await repo.git("branch", "trunk");
  await repo.cabaret("create", "main", "--parent", "trunk");
  expect(await repo.cabaret("comment", "ship it")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("log")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"trunk"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${head}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"owner"}}\n' +
      '{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"comment","text":"ship it"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

test("comment fails on a change that does not exist", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("comment", "--change", "ghost", "anyone home?")).toEqual({
    stdout: "",
    stderr: 'change does not exist: "ghost"; run `cabaret create`, or `cabaret pull` to import open forge changes\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("log", "ghost")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("comment rejects an empty comment", async () => {
  const repo = await makeRepo();
  const root = await repo.git("rev-parse", "main");
  await repo.cabaret("create", "gadget");
  const result = await repo.cabaret("comment", "--change", "gadget", "");
  expect(result.exitCode).toBe(ExitCode.InvalidArgument);
  expect(await repo.cabaret("log", "gadget")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${root}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"owner"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

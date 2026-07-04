import { ExitCode } from "@stricli/core";
import { expect, test } from "vitest";
import { makeRepo } from "./fixture.js";

test("comments add appends a comment entry to the current change's log", async () => {
  const repo = await makeRepo();
  const head = await repo.git("rev-parse", "main");
  await repo.git("branch", "trunk");
  await repo.cabaret("create", "main", "--parent", "trunk");
  expect(await repo.cabaret("comments", "add", "ship it")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("log")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"trunk"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${head}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"comment","text":"ship it"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

test("comments show prints each comment's time, author, and text, oldest first", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "gadget");
  await repo.cabaret("comments", "add", "--change", "gadget", "does this handle empty diffs?");
  await repo.cabaret("comments", "add", "--change", "gadget", "second thoughts:\n\nthe flag name reads oddly");
  expect(await repo.cabaret("comments", "show", "gadget")).toEqual({
    stdout:
      "2025-05-23T11:33:20.003Z alice@example.com\n" +
      "  does this handle empty diffs?\n" +
      "\n" +
      "2025-05-23T11:33:20.004Z alice@example.com\n" +
      "  second thoughts:\n" +
      "\n" +
      "  the flag name reads oddly\n",
    stderr: "",
    exitCode: 0,
  });
});

test("comments show prints nothing for a change with no comments", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "quiet");
  expect(await repo.cabaret("comments", "show", "quiet")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("comments add fails on a change that does not exist", async () => {
  const repo = await makeRepo();
  const result = await repo.cabaret("comments", "add", "--change", "ghost", "anyone home?");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('change does not exist: "ghost"; run `cabaret create` first');
  expect(await repo.cabaret("log", "ghost")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("comments show fails on a change that does not exist", async () => {
  const repo = await makeRepo();
  const result = await repo.cabaret("comments", "show", "ghost");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('change does not exist: "ghost"; run `cabaret create` first');
});

test("comments add rejects an empty comment", async () => {
  const repo = await makeRepo();
  const root = await repo.git("rev-parse", "main");
  await repo.cabaret("create", "gadget");
  const result = await repo.cabaret("comments", "add", "--change", "gadget", "");
  expect(result.exitCode).toBe(ExitCode.InvalidArgument);
  expect(await repo.cabaret("log", "gadget")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${root}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

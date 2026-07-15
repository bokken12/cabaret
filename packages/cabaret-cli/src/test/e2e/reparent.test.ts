import { expect, test } from "vitest";
import { makeRepo } from "./fixture.js";

test("reparent appends a set-parent entry to the change's log", async () => {
  const repo = await makeRepo();
  const root = await repo.git("rev-parse", "main");
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
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"owner"}}\n' +
      '{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-parent","parent":"trunk"}}\n',
    stderr: "",
    exitCode: 0,
  });
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

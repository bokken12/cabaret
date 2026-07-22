import { expect, test } from "vitest";
import { addChange, makeRepo } from "./fixture.js";

test("permanent set records the flag and show reads it back", async () => {
  const repo = await makeRepo();
  await addChange(repo, "umbrella");
  expect(await repo.cabaret("permanent", "show")).toEqual({ stdout: "false\n", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("permanent", "set", "true")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("permanent", "show")).toEqual({ stdout: "true\n", stderr: "", exitCode: 0 });
  expect((await repo.cabaret("dev", "log", "umbrella")).stdout).toContain(
    '"action":{"kind":"set-permanent","permanent":true}',
  );
  expect(await repo.cabaret("permanent", "set", "false")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("permanent", "show")).toEqual({ stdout: "false\n", stderr: "", exitCode: 0 });
});

test("permanent set rejects a non-boolean", async () => {
  const repo = await makeRepo();
  await addChange(repo, "umbrella");
  const { stderr, exitCode } = await repo.cabaret("permanent", "set", "maybe");
  expect({ stderr, exitCode }).toEqual({
    stderr: 'Failed to parse "maybe" for permanent: not a boolean: "maybe" (true or false)\n',
    exitCode: -4,
  });
});

test("create --permanent starts the change permanent", async () => {
  const repo = await makeRepo();
  const tip = await repo.git("rev-parse", "main");
  expect(await repo.cabaret("create", "umbrella", "--permanent")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("permanent", "show", "--change", "umbrella")).toEqual({
    stdout: "true\n",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("dev", "log", "umbrella")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${tip}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      '{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-permanent","permanent":true}}\n',
    stderr: "",
    exitCode: 0,
  });
});

test("archive refuses a permanent change until it is made ordinary", async () => {
  const repo = await makeRepo();
  await addChange(repo, "umbrella");
  await repo.cabaret("permanent", "set", "true");
  expect(await repo.cabaret("archive")).toEqual({
    stdout: "",
    stderr: 'change is permanent: "umbrella"; run `cab permanent set false` first\n',
    exitCode: 1,
  });
  await repo.cabaret("permanent", "set", "false");
  expect(await repo.cabaret("archive")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("show lists a permanent row only for a permanent change", async () => {
  const repo = await makeRepo();
  await addChange(repo, "umbrella");
  await repo.cabaret("permanent", "set", "true");
  expect((await repo.cabaret("show")).stdout).toMatchInlineSnapshot(`
    "umbrella
    ========

    ╭───────────┬───────────────────╮
    │ attribute │ value             │
    ├───────────┼───────────────────┤
    │ next step │ widen reviewing   │
    │ owner     │ alice@example.com │
    │ reviewing │ none              │
    │ permanent │ yes               │
    │ parent    │ main              │
    │ tip       │ 29423b4fc10d      │
    │ base      │ 1ac0b33426d0      │
    │ workspace │ .                 │
    ╰───────────┴───────────────────╯

    Remaining review:
      alice@example.com: 1 file

    Files to review:
      umbrella.txt
    "
  `);
  await repo.cabaret("permanent", "set", "false");
  expect((await repo.cabaret("show")).stdout).not.toContain("permanent");
});

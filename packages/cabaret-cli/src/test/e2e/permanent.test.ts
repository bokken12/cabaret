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

test("landing a permanent change keeps it live at the landing commit", async () => {
  const repo = await makeRepo();
  await addChange(repo, "umbrella");
  await repo.cabaret("permanent", "set", "true");
  await repo.cabaret("mark", "--tip", "umbrella", "umbrella.txt");
  expect(await repo.cabaret("land", "umbrella")).toEqual({
    stdout: 'pushed "main" to origin\n',
    stderr: "",
    exitCode: 0,
  });
  const merge = await repo.git("rev-parse", "main");
  // The branch advanced to the land merge and the base pinned there: an
  // empty diff, ready for the next cycle of work.
  expect(await repo.git("rev-parse", "umbrella")).toBe(merge);
  const log = (await repo.cabaret("dev", "log", "umbrella")).stdout;
  expect(log).toContain(`"action":{"kind":"land","merge":"${merge}"}`);
  expect(log).toContain(`"action":{"kind":"set-base","base":"${merge}"}`);
  expect(log).not.toContain('"set-archived"');
  expect((await repo.cabaret("show", "umbrella")).stdout).toContain("│ next step │ add code");
});

test("a permanent umbrella keeps its children and lands cycle after cycle", async () => {
  const repo = await makeRepo();
  await addChange(repo, "umbrella");
  await repo.cabaret("permanent", "set", "true");
  await repo.cabaret("mark", "--tip", "umbrella", "umbrella.txt");
  await repo.cabaret("land", "umbrella");
  // Creating off the landed umbrella needs no override: it is live.
  await addChange(repo, "leaf");
  await repo.cabaret("mark", "--tip", "leaf", "--change", "leaf", "leaf.txt");
  expect(await repo.cabaret("land", "leaf")).toEqual({
    stdout: 'pushed "umbrella" to origin\n',
    stderr: "",
    exitCode: 0,
  });
  // The leaf landed into the umbrella and archived under it, not walked away.
  const leafLog = (await repo.cabaret("dev", "log", "leaf")).stdout;
  expect(leafLog).toContain('"kind":"set-parent","parent":"umbrella"');
  expect(leafLog).not.toContain('"kind":"set-parent","parent":"main"');
  // The umbrella grew by the leaf's land; its second cycle lands that into main.
  expect(await repo.cabaret("land", "umbrella")).toEqual({
    stdout: 'pushed "main" to origin\n',
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("show", "main:leaf.txt")).toBe("leaf work");
  const log = (await repo.cabaret("dev", "log", "umbrella")).stdout;
  expect(log.match(/"kind":"land"/g)?.length).toBe(2);
  expect(log).not.toContain('"set-archived"');
});

test("a permanent change squash-lands and carries on append-only", async () => {
  const repo = await makeRepo();
  await repo.git("config", "cabaret.landMethod", "squash");
  await addChange(repo, "umbrella");
  await repo.cabaret("permanent", "set", "true");
  await repo.cabaret("mark", "--tip", "umbrella", "umbrella.txt");
  const oldTip = await repo.git("rev-parse", "umbrella");
  expect(await repo.cabaret("land", "umbrella")).toEqual({
    stdout: 'pushed "main" to origin\n',
    stderr: "",
    exitCode: 0,
  });
  const squash = await repo.git("rev-parse", "main");
  // The squash descends from none of the branch's history, so it merged in:
  // the old tip stays an ancestor, and the branch's tree matches main's.
  await repo.git("merge-base", "--is-ancestor", oldTip, "umbrella");
  await repo.git("merge-base", "--is-ancestor", squash, "umbrella");
  expect(await repo.git("rev-parse", "umbrella^{tree}")).toBe(await repo.git("rev-parse", `${squash}^{tree}`));
  // The next cycle squashes only its own work: no duplicate of cycle one.
  await repo.git("checkout", "-q", "umbrella");
  await repo.write("umbrella.txt", "umbrella work v2\n");
  await repo.git("commit", "-qam", "second cycle");
  expect(await repo.cabaret("land", "umbrella", "--even-though-unreviewed")).toEqual({
    stdout: 'pushed "main" to origin\n',
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("show", "main:umbrella.txt")).toBe("umbrella work v2");
  expect(await repo.git("show", "--name-only", "--format=", "main")).toBe("umbrella.txt");
});

test("show lists a permanent row only for a permanent change", async () => {
  const repo = await makeRepo();
  await addChange(repo, "umbrella");
  await repo.cabaret("permanent", "set", "true");
  expect((await repo.cabaret("show")).stdout).toMatchInlineSnapshot(`
    "umbrella
    ========

    ╭───────────┬────────────────────────────────╮
    │ attribute │ value                          │
    ├───────────┼────────────────────────────────┤
    │ next step │ review                         │
    │ owner     │ alice@example.com              │
    │ reviewing │ everyone                       │
    │ permanent │ yes                            │
    │ parent    │ main                           │
    │ tip       │ 29423b4fc10d (ahead of origin) │
    │ base      │ 1ac0b33426d0                   │
    │ workspace │ .                              │
    ╰───────────┴────────────────────────────────╯

    Remaining review:
      alice@example.com: 1 file

    Files to review:
      umbrella.txt
    "
  `);
  await repo.cabaret("permanent", "set", "false");
  expect((await repo.cabaret("show")).stdout).not.toContain("permanent");
});

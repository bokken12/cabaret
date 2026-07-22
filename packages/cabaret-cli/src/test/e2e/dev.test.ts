import { expect, test } from "vitest";
import { addChange, makeRepo } from "./fixture.js";

test("log defaults to the change of the checked-out branch", async () => {
  const repo = await makeRepo();
  const root = await repo.git("rev-parse", "main");
  await repo.git("branch", "trunk");
  await repo.cabaret("create", "main", "--parent", "trunk");
  expect(await repo.cabaret("dev", "log")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-name","name":"main"}}\n' +
      '{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-parent","parent":"trunk"}}\n' +
      `{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-base","base":"${root}"}}\n` +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

test("a change with no log has the empty log", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("dev", "log", "unlogged")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("log rejects a malformed change name", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("dev", "log", "not..a..ref")).toEqual({
    stdout: "",
    stderr: 'not a valid branch name: "not..a..ref"\n',
    exitCode: 1,
  });
});

test("review-all marks every owed file, then finds nothing owed", async () => {
  const repo = await makeRepo();
  await addChange(repo, "widgets");
  await repo.cabaret("reviewing", "set", "owner");
  await addChange(repo, "gadgets");
  await repo.cabaret("reviewing", "set", "owner");

  expect(await repo.cabaret("dev", "review-all")).toEqual({
    stdout: "widgets: marked 1 file\ngadgets: marked 1 file\n",
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("home")).stdout).toMatchInlineSnapshot(`
    "Home
    ====

    Changes to review:
    ╭────────┬────────╮
    │ change │ review │
    ├────────┼────────┤
    ╰────────┴────────╯

    Changes you own:
    ╭────────────┬───────────╮
    │ change     │ next step │
    ├────────────┼───────────┤
    │ widgets    │ land      │
    │ └─ gadgets │ land      │
    ╰────────────┴───────────╯

    Workspaces on this device:
    ╭────────────┬──────╮
    │ change     │ note │
    ├────────────┼──────┤
    │ widgets    │      │
    │ └─ gadgets │      │
    ╰────────────┴──────╯
    "
  `);
  expect(await repo.cabaret("dev", "review-all")).toEqual({
    stdout: "nothing owed\n",
    stderr: "",
    exitCode: 0,
  });
});

test("review-all marks as your writing identity alone; --for marks as another", async () => {
  const repo = await makeRepo();
  await repo.git("config", "cabaret.alias", "agent@example.com");
  await addChange(repo, "widgets");
  const policy = { rules: [{ match: "*.txt", require: { atLeast: 1, of: ["agent@example.com"] } }] };
  await repo.write(".obligations", `${JSON.stringify(policy)}\n`);
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "policy");
  await repo.cabaret("reviewing", "set", "everyone");

  expect(await repo.cabaret("dev", "review-all")).toEqual({
    stdout: "widgets: marked 2 files\n",
    stderr: "",
    exitCode: 0,
  });
  // The owner's marks cannot satisfy the demand naming only the alias, so
  // the file stays owed — to the alias, not to another default run.
  expect(await repo.cabaret("dev", "review-all")).toEqual({
    stdout: "nothing owed\n",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("dev", "review-all", "--for", "agent@example.com")).toEqual({
    stdout: "widgets: marked 1 file\n",
    stderr: "",
    exitCode: 0,
  });
  const { stdout } = await repo.cabaret("dev", "log", "widgets");
  expect(stdout).toContain('"user":"agent@example.com","action":{"kind":"review","file":"widgets.txt"');
  expect(stdout).not.toContain('"user":"agent@example.com","action":{"kind":"review","file":".obligations"');
  expect(await repo.cabaret("dev", "review-all", "--for", "agent@example.com")).toEqual({
    stdout: "nothing owed\n",
    stderr: "",
    exitCode: 0,
  });
});

test("review-all leaves a draft alone", async () => {
  const repo = await makeRepo();
  await addChange(repo, "widgets");
  await repo.cabaret("reviewing", "set", "none", "--change", "widgets");
  const before = await repo.cabaret("dev", "log", "widgets");

  expect(await repo.cabaret("dev", "review-all")).toEqual({ stdout: "nothing owed\n", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("dev", "log", "widgets")).toEqual(before);
});

test("wipe deletes logs and fetched logs; branches stay", async () => {
  const repo = await makeRepo();
  await addChange(repo, "widgets");
  await repo.cabaret("mark", "--tip", "HEAD", "widgets.txt");
  await repo.cabaret("fetch");

  // One change, even though its log and the fetched copy are two refs.
  expect(await repo.cabaret("dev", "wipe")).toEqual({
    stdout: "wiped the logs of 1 change\n",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("for-each-ref", "refs/cabaret/")).toBe("");
  expect(await repo.git("rev-parse", "--verify", "refs/heads/widgets")).not.toBe("");
  expect(await repo.cabaret("dev", "log", "widgets")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("wipe is local: origin keeps its logs, so fetch restores them", async () => {
  const repo = await makeRepo();
  await addChange(repo, "widgets");
  await repo.cabaret("mark", "--tip", "HEAD", "widgets.txt");
  await repo.cabaret("fetch");
  const before = await repo.cabaret("dev", "log", "widgets");

  await repo.cabaret("dev", "wipe");
  expect(await repo.cabaret("dev", "log", "widgets")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  await repo.cabaret("fetch");
  expect(await repo.cabaret("dev", "log", "widgets")).toEqual(before);
});

test("wipe --remote deletes origin's logs too", async () => {
  const repo = await makeRepo();
  await addChange(repo, "widgets");
  await addChange(repo, "gadgets");
  await repo.cabaret("fetch");

  expect(await repo.cabaret("dev", "wipe", "--remote")).toEqual({
    stdout: "wiped the logs of 2 changes\nwiped the logs of 2 changes on origin\n",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("ls-remote", "origin", "refs/cabaret/*")).toBe("");
  expect(await repo.cabaret("dev", "wipe", "--remote")).toEqual({
    stdout: "wiped the logs of 0 changes\nwiped the logs of 0 changes on origin\n",
    stderr: "",
    exitCode: 0,
  });
});

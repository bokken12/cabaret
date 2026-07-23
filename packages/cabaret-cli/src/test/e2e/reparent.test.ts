import { expect, test } from "vitest";
import { addChange, makeClone, makeRepo } from "./fixture.js";

test("reparent appends a set-parent entry to the change's log", async () => {
  const repo = await makeRepo();
  const root = await repo.git("rev-parse", "main");
  await repo.git("branch", "trunk");
  await repo.cabaret("create", "feature");
  expect(await repo.cabaret("reparent", "feature", "trunk")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("dev", "log", "feature")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${root}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      '{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-parent","parent":"trunk"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

test("reparent accepts a parent held only at origin", async () => {
  const repo = await makeRepo();
  const root = await repo.git("rev-parse", "main");
  await repo.git("push", "-q", "origin", "main");
  await repo.cabaret("create", "feature");
  // A second machine publishes a branch this clone has fetched but never
  // checked out.
  const other = await makeClone(repo, "bob@example.com");
  await other.git("checkout", "-qb", "trunk");
  await other.write("trunk.txt", "trunk work\n");
  await other.git("add", "-A");
  await other.git("commit", "-qm", "trunk work");
  await other.git("push", "-q", "origin", "trunk");
  await repo.git("fetch", "-q", "origin");
  expect(await repo.cabaret("reparent", "feature", "trunk")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("dev", "log", "feature")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${root}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      '{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-parent","parent":"trunk"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

test("reparent onto a branch that does not exist fails, leaving the log untouched", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "feature");
  const before = await repo.cabaret("dev", "log", "feature");
  expect(await repo.cabaret("reparent", "feature", "trunk")).toEqual({
    stdout: "",
    stderr: 'parent branch does not exist: "trunk"\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("dev", "log", "feature")).toEqual(before);
});

test("reparent onto the change itself fails, leaving the log untouched", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "feature");
  const before = await repo.cabaret("dev", "log", "feature");
  expect(await repo.cabaret("reparent", "feature", "feature")).toEqual({
    stdout: "",
    stderr: 'change cannot be its own parent: "feature"\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("dev", "log", "feature")).toEqual(before);
});

test("reparent fails without a git identity, leaving the log untouched", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "feature");
  const before = await repo.cabaret("dev", "log", "feature");
  await repo.git("config", "--unset", "user.email");
  expect(await repo.cabaret("reparent", "feature", "trunk")).toEqual({
    stdout: "",
    stderr: "git config user.email is not set; log entries need an identity\n",
    exitCode: 1,
  });
  expect(await repo.cabaret("dev", "log", "feature")).toEqual(before);
});

test("reparent rejects an empty git identity", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "feature");
  const before = await repo.cabaret("dev", "log", "feature");
  await repo.git("config", "user.email", "");
  expect(await repo.cabaret("reparent", "feature", "trunk")).toEqual({
    stdout: "",
    stderr: "git config user.email must be nonempty\n",
    exitCode: 1,
  });
  expect(await repo.cabaret("dev", "log", "feature")).toEqual(before);
});

test("reparent refuses an archived parent until overridden", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "gadget");
  await repo.cabaret("create", "widgets");
  await repo.cabaret("archive", "--change", "gadget");
  expect(await repo.cabaret("reparent", "widgets", "gadget")).toEqual({
    stdout: "",
    stderr:
      'parent "gadget" is archived; run `cab archive --undo` first, or pass --even-though-parent-archived to proceed\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("reparent", "widgets", "gadget", "--even-though-parent-archived")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("dev", "log", "widgets")).stdout).toContain('"kind":"set-parent","parent":"gadget"');
});

test("reparent refuses a landed parent, naming where the code went", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await repo.cabaret("mark", "--tip", "gadget", "gadget.txt");
  await repo.cabaret("land", "gadget");
  await repo.cabaret("create", "widgets", "--parent", "main");
  expect(await repo.cabaret("reparent", "widgets", "gadget")).toEqual({
    stdout: "",
    stderr:
      'parent "gadget" landed into "main"; build on that instead, or pass --even-though-parent-archived to proceed\n',
    exitCode: 1,
  });
});

test("reparent refuses a diverged parent until overridden", async () => {
  const repo = await makeRepo();
  await repo.git("push", "-q", "origin", "main");
  await repo.cabaret("create", "feature");
  // The readings part ways: origin's main gains work while this clone's main
  // takes local work, so no freshest reading exists.
  const other = await makeClone(repo, "bob@example.com");
  await other.git("checkout", "-q", "main");
  await other.write("trunk.txt", "trunk work\n");
  await other.git("add", "-A");
  await other.git("commit", "-qm", "trunk work");
  await other.git("push", "-q", "origin", "main");
  await repo.write("local.txt", "local work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "local work");
  await repo.git("fetch", "-q", "origin");
  expect(await repo.cabaret("reparent", "feature", "main")).toEqual({
    stdout: "",
    stderr:
      'local "main" has diverged from origin\'s copy; sync it first, ' +
      "or pass --even-though-parent-diverged to proceed on the local reading\n",
    exitCode: 1,
  });
  expect(await repo.cabaret("reparent", "feature", "main", "--even-though-parent-diverged")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
});

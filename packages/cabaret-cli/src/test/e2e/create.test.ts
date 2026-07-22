import { expect, test } from "vitest";
import { addChange, makeClone, makeRepo, type TestRepo } from "./fixture.js";

/** Commit `file` on `branch` of `repo` and push it; a branch origin lacks is created at origin/main. */
async function pushWork(repo: TestRepo, branch: string, file: string): Promise<void> {
  await (branch === "main"
    ? repo.git("checkout", "-q", "main")
    : repo.git("checkout", "-q", "-b", branch, "origin/main"));
  await repo.write(file, `${file} content\n`);
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", `${file} work`);
  await repo.git("push", "-q", "origin", branch);
}

test("create makes a new branch at the parent's tip and initializes its log", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("create", "feature")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  const tip = await repo.git("rev-parse", "main");
  expect(await repo.git("rev-parse", "feature")).toBe(tip);
  // The current branch is adopted as the parent, not switched away from.
  expect(await repo.git("symbolic-ref", "--short", "HEAD")).toBe("main");
  expect(await repo.cabaret("dev", "log", "feature")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${tip}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

test("create adopts an existing branch, based where it left the parent", async () => {
  const repo = await makeRepo();
  const root = await repo.git("rev-parse", "main");
  await repo.git("branch", "trunk");
  await repo.write("feature.txt", "work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "feature work");
  expect(await repo.cabaret("create", "main", "--parent", "trunk")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("dev", "log", "main")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"trunk"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${root}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

test("create --owner records the given owner instead of the creator", async () => {
  const repo = await makeRepo();
  const tip = await repo.git("rev-parse", "main");
  expect(await repo.cabaret("create", "feature", "--owner", "bob@example.com")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("dev", "log", "feature")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${tip}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"bob@example.com"}}\n' +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

test("create fails when the change already exists", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "feature");
  const before = await repo.cabaret("dev", "log", "feature");
  expect(await repo.cabaret("create", "feature")).toEqual({
    stdout: "",
    stderr: 'change already exists: "feature"\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("dev", "log", "feature")).toEqual(before);
});

test("create fails when the parent branch does not exist, creating nothing", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("create", "feature", "--parent", "ghost")).toEqual({
    stdout: "",
    stderr: 'parent branch does not exist: "ghost"\n',
    exitCode: 1,
  });
  expect(await repo.git("branch", "--list", "feature")).toBe("");
  expect(await repo.cabaret("dev", "log", "feature")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("create fails without a git identity, leaving no branch behind", async () => {
  const repo = await makeRepo();
  await repo.git("config", "--unset", "user.email");
  expect(await repo.cabaret("create", "feature")).toEqual({
    stdout: "",
    stderr: "git config user.email is not set; log entries need an identity\n",
    exitCode: 1,
  });
  expect(await repo.git("branch", "--list", "feature")).toBe("");
});

test("create rejects a change that is its own parent", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("create", "main")).toEqual({
    stdout: "",
    stderr: 'change cannot be its own parent: "main"\n',
    exitCode: 1,
  });
});

test("create bases a new change on origin's copy of a parent that is merely behind", async () => {
  const repo = await makeRepo();
  await repo.git("push", "-q", "origin", "main");
  // A second machine advances origin's main; this clone fetches the news but
  // its own main stays put.
  const other = await makeClone(repo, "bob@example.com");
  await pushWork(other, "main", "trunk.txt");
  await repo.git("fetch", "-q", "origin");
  const localMain = await repo.git("rev-parse", "main");
  const originMain = await repo.git("rev-parse", "origin/main");
  expect(await repo.cabaret("create", "widgets")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  // The change starts at the freshest reading; local main is just a working
  // position and stays put.
  expect(await repo.git("rev-parse", "widgets")).toBe(originMain);
  expect(await repo.git("rev-parse", "main")).toBe(localMain);
  expect(await repo.cabaret("dev", "log", "widgets")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${originMain}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

test("create refuses a diverged parent, creating nothing", async () => {
  const repo = await makeRepo();
  await repo.git("push", "-q", "origin", "main");
  // The readings part ways: origin's main gains trunk work while this
  // clone's main takes local work, so no freshest reading exists.
  const other = await makeClone(repo, "bob@example.com");
  await pushWork(other, "main", "trunk.txt");
  await repo.write("local.txt", "local work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "local work");
  await repo.git("fetch", "-q", "origin");
  expect(await repo.cabaret("create", "widgets")).toEqual({
    stdout: "",
    stderr: 'local "main" has diverged from origin\'s copy; sync it first\n',
    exitCode: 1,
  });
  expect(await repo.git("branch", "--list", "widgets")).toBe("");
  expect(await repo.cabaret("dev", "log", "widgets")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("create accepts a parent held only at origin", async () => {
  const repo = await makeRepo();
  await repo.git("push", "-q", "origin", "main");
  const other = await makeClone(repo, "bob@example.com");
  await pushWork(other, "gadget", "gadget.txt");
  await repo.git("fetch", "-q", "origin");
  expect(await repo.cabaret("create", "widgets", "--parent", "gadget")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("rev-parse", "widgets")).toBe(await repo.git("rev-parse", "origin/gadget"));
  // The parent itself stays unmaterialized.
  expect(await repo.git("branch", "--list", "gadget")).toBe("");
});

test("create adopts a branch held only at origin, leaving it unmaterialized", async () => {
  const repo = await makeRepo();
  const root = await repo.git("rev-parse", "main");
  await repo.git("push", "-q", "origin", "main");
  const other = await makeClone(repo, "bob@example.com");
  await pushWork(other, "gadget", "gadget.txt");
  await repo.git("fetch", "-q", "origin");
  expect(await repo.cabaret("create", "gadget")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  // Adopted reading origin's copy — based where it left main — with the
  // branch appearing only on engagement, like an imported change.
  expect(await repo.git("branch", "--list", "gadget")).toBe("");
  expect(await repo.cabaret("dev", "log", "gadget")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${root}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

test("create refuses a landed parent until overridden, naming where the code went", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await repo.cabaret("mark", "--tip", "gadget", "gadget.txt");
  expect(await repo.cabaret("land", "gadget")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("create", "widgets", "--parent", "gadget")).toEqual({
    stdout: "",
    stderr: 'parent "gadget" has landed; create off "main" instead, or pass --even-though-parent-landed to proceed\n',
    exitCode: 1,
  });
  expect(await repo.git("branch", "--list", "widgets")).toBe("");
  expect(await repo.cabaret("dev", "log", "widgets")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("create", "widgets", "--parent", "gadget", "--even-though-parent-landed")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("rev-parse", "widgets")).toBe(await repo.git("rev-parse", "gadget"));
});

test("create refuses an archived parent until overridden", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "gadget");
  await repo.cabaret("archive", "--change", "gadget");
  expect(await repo.cabaret("create", "widgets", "--parent", "gadget")).toEqual({
    stdout: "",
    stderr:
      'parent "gadget" is archived; run `cab archive --undo` first, or pass --even-though-parent-archived to proceed\n',
    exitCode: 1,
  });
  expect(await repo.git("branch", "--list", "widgets")).toBe("");
  expect(await repo.cabaret("dev", "log", "widgets")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("create", "widgets", "--parent", "gadget", "--even-though-parent-archived")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("rev-parse", "widgets")).toBe(await repo.git("rev-parse", "gadget"));
});

test("create refuses adopting a branch whose readings have diverged", async () => {
  const repo = await makeRepo();
  await repo.git("push", "-q", "origin", "main");
  const other = await makeClone(repo, "bob@example.com");
  await pushWork(other, "gadget", "gadget.txt");
  await repo.git("branch", "gadget");
  await repo.git("checkout", "-q", "gadget");
  await repo.write("local.txt", "local work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "local gadget work");
  await repo.git("checkout", "-q", "main");
  await repo.git("fetch", "-q", "origin");
  expect(await repo.cabaret("create", "gadget")).toEqual({
    stdout: "",
    stderr: 'local "gadget" has diverged from origin\'s copy; sync it first\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("dev", "log", "gadget")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

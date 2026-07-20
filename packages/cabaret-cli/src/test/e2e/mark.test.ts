import { ExitCode } from "@stricli/core";
import { expect, test } from "vitest";
import { makeRepo, type TestRepo } from "./fixture.js";

/** A repo whose change on `main` (with parent `trunk`) adds `files` in one commit. */
async function makeChange(files: Readonly<Record<string, string>>): Promise<TestRepo> {
  const repo = await makeRepo();
  await repo.git("branch", "trunk");
  for (const [path, content] of Object.entries(files)) {
    await repo.write(path, content);
  }
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "work");
  await repo.cabaret("create", "main", "--parent", "trunk");
  return repo;
}

test("mark records review of files at the given tip", async () => {
  const repo = await makeChange({ "src/a.ts": "a\n", "src/b.ts": "b\n" });
  const base = await repo.git("rev-parse", "trunk");
  const tip = await repo.git("rev-parse", "main");
  expect(await repo.cabaret("mark", "--tip", tip, "src/a.ts", "src/b.ts")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("dev", "log")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"trunk"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${base}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      `{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"review","file":"src/a.ts","base":"${base}","tip":"${tip}"}}\n` +
      `{"timestamp":1748000000005,"user":"alice@example.com","action":{"kind":"review","file":"src/b.ts","base":"${base}","tip":"${tip}"}}\n`,
    stderr: "",
    exitCode: 0,
  });
});

test("mark requires the tip, so a mark always states what was read", async () => {
  const repo = await makeChange({ "src/a.ts": "a\n" });
  const result = await repo.cabaret("mark", "src/a.ts");
  expect(result.exitCode).toBe(ExitCode.InvalidArgument);
  expect(await repo.cabaret("dev", "log")).toMatchObject({ stderr: "" });
});

test("mark --tip resolves a symbolic revision to a full hash", async () => {
  const repo = await makeChange({ "greeting.txt": "hello\n" });
  const root = await repo.git("rev-parse", "trunk");
  expect(await repo.cabaret("mark", "--tip", "HEAD^", "greeting.txt")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("dev", "log")).stdout).toContain(
    `{"kind":"review","file":"greeting.txt","base":"${root}","tip":"${root}"}`,
  );
});

test("mark fails on an unknown tip revision, leaving the log untouched", async () => {
  const repo = await makeChange({ "src/a.ts": "a\n" });
  const before = await repo.cabaret("dev", "log");
  expect(await repo.cabaret("mark", "--tip", "no-such-rev", "src/a.ts")).toEqual({
    stdout: "",
    stderr: 'unknown revision: "no-such-rev"\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("dev", "log")).toEqual(before);
});

test("a mark at the tip that was read gives partial credit across a race", async () => {
  const repo = await makeChange({ "greeting.txt": "hello\n" });
  const read = await repo.git("rev-parse", "main");
  await repo.write("greeting.txt", "hello\nworld\n");
  await repo.git("commit", "-qam", "expand greeting");
  // The tip moved after the diff was read; marking at the read tip is still
  // a true statement, and only the increment is left.
  expect(await repo.cabaret("mark", "--tip", read, "greeting.txt")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect((await repo.cabaret("review", "greeting.txt")).stdout).toMatchInlineSnapshot(`
    "Review main
    ===========

    Reviewing up to e65764dea55e.

      greeting.txt

    greeting.txt in main (up to e65764dea55e)

    -1,1 +1,2
      hello
    +|world

    Record review of what you have read:
      cabaret mark --tip e65764dea55e greeting.txt
    "
  `);
});

test("a pattern marks every matching file, and only those", async () => {
  const repo = await makeChange({ "src/a.ts": "a\n", "src/b.ts": "b\n", "docs/notes.md": "# Notes\n" });
  expect(await repo.cabaret("mark", "--tip", "HEAD", "src/*.ts")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  const marked = (await repo.cabaret("dev", "log")).stdout;
  expect(marked).toContain('"kind":"review","file":"src/a.ts"');
  expect(marked).toContain('"kind":"review","file":"src/b.ts"');
  expect(marked).not.toContain('"file":"docs/notes.md"');
  expect(await repo.cabaret("mark", "--tip", "HEAD", "**")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect((await repo.cabaret("dev", "log")).stdout).toContain('"kind":"review","file":"docs/notes.md"');
});

test("review shows nothing left once every file is marked", async () => {
  const repo = await makeChange({ "src/a.ts": "a\n" });
  await repo.cabaret("mark", "--tip", "HEAD", "**");
  expect(await repo.cabaret("review")).toEqual({
    stdout: "Review main\n===========\n\nNothing left to review.\n",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("mark", "--tip", "HEAD", "src/a.ts")).toEqual({
    stdout: "",
    stderr: 'nothing is left to review in "main"\n',
    exitCode: 1,
  });
});

test("a pattern matching no file with review left fails", async () => {
  const repo = await makeChange({ "src/a.ts": "a\n" });
  expect(await repo.cabaret("mark", "--tip", "HEAD", "*.rs")).toEqual({
    stdout: "",
    stderr: 'no file with review left matches "*.rs"\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("mark", "--tip", "HEAD", "trunk.txt")).toEqual({
    stdout: "",
    stderr: "no review left in trunk.txt\n",
    exitCode: 1,
  });
});

test("mark from a subdirectory records repo-relative paths", async () => {
  const repo = await makeChange({ "src/a.ts": "a\n", "top.ts": "top\n" });
  const base = await repo.git("rev-parse", "trunk");
  const tip = await repo.git("rev-parse", "main");
  expect(await repo.cabaretIn("src", "mark", "--tip", "HEAD", "a.ts", "../top.ts")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("dev", "log")).stdout).toContain(
    `{"kind":"review","file":"src/a.ts","base":"${base}","tip":"${tip}"}`,
  );
  expect((await repo.cabaret("dev", "log")).stdout).toContain(
    `{"kind":"review","file":"top.ts","base":"${base}","tip":"${tip}"}`,
  );
});

test("mark refuses a change with conflict markers, leaving the log untouched", async () => {
  const repo = await makeRepo();
  await repo.git("branch", "trunk");
  await repo.write("shared.txt", "<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> parent\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "conflicted");
  await repo.cabaret("create", "main", "--parent", "trunk");
  const before = await repo.cabaret("dev", "log");
  expect(await repo.cabaret("mark", "--tip", "HEAD", "shared.txt")).toEqual({
    stdout: "",
    stderr: '"main" has unresolved conflicts in shared.txt; fix the markers and amend\n',
    exitCode: 1,
  });
  // The override excuses reviewing ahead of one's turn, not markers.
  expect(await repo.cabaret("mark", "--tip", "HEAD", "--even-though-not-reviewing", "shared.txt")).toEqual({
    stdout: "",
    stderr: '"main" has unresolved conflicts in shared.txt; fix the markers and amend\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("dev", "log")).toEqual(before);
});

test("mark rejects a path outside the repository, leaving the log untouched", async () => {
  const repo = await makeChange({ "src/a.ts": "a\n" });
  const before = await repo.cabaret("dev", "log");
  expect(await repo.cabaret("mark", "--tip", "HEAD", "../outside.ts")).toEqual({
    stdout: "",
    stderr: 'path is outside the repository: "../outside.ts"\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("dev", "log")).toEqual(before);
});

test("mark reads the change's branch even when a tag shadows its name", async () => {
  const repo = await makeRepo();
  await repo.git("checkout", "-qb", "gadget");
  await repo.write("gadget.txt", "gadget work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "gadget work");
  const tip = await repo.git("rev-parse", "gadget");
  await repo.git("checkout", "-q", "main");
  // A tag at the workless parent: resolving it instead of the branch would
  // leave the change with nothing to review.
  await repo.git("tag", "gadget", "main");
  await repo.cabaret("create", "gadget", "--parent", "main");
  expect(await repo.cabaret("mark", "--change", "gadget", "--tip", tip, "gadget.txt")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("dev", "log", "gadget")).stdout).toContain(`"tip":"${tip}"`);
});

test("mark fails on a change that does not exist, leaving the log untouched", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("mark", "--tip", "HEAD", "src/a.ts")).toEqual({
    stdout: "",
    stderr: 'change does not exist: "main"; run `cabaret create`, or `cabaret fetch` to import open forge changes\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("dev", "log")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("mark requires at least one file", async () => {
  const repo = await makeRepo();
  const result = await repo.cabaret("mark", "--tip", "HEAD");
  expect(result.exitCode).toBe(ExitCode.InvalidArgument);
  expect(await repo.cabaret("dev", "log")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

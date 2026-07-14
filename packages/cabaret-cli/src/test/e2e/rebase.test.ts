import { expect, test } from "vitest";
import { addChange, makeRepo, type TestRepo } from "./fixture.js";

/**
 * A repo with change `child` (one commit adding child.txt) stacked on change
 * `parent` (one commit adding parent.txt), both created through cabaret.
 * Leaves HEAD on `child`.
 */
async function makeStack(): Promise<TestRepo> {
  const repo = await makeRepo();
  await repo.cabaret("create", "parent");
  await repo.git("checkout", "-q", "parent");
  await repo.write("parent.txt", "parent v1\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "parent work");
  await repo.cabaret("create", "child");
  await repo.git("checkout", "-q", "child");
  await repo.write("child.txt", "child work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "child work");
  return repo;
}

/** Rewrite `parent`'s commit so the child's stored base leaves its history. */
async function amendParent(repo: TestRepo): Promise<void> {
  await repo.git("checkout", "-q", "parent");
  await repo.write("parent.txt", "parent v2\n");
  await repo.git("commit", "-qa", "--amend", "-m", "parent work, amended");
}

test("a parent rewrite stays out of the child's diff until it rebases", async () => {
  const repo = await makeStack();
  await amendParent(repo);
  // The stored base still holds parent.txt as the child saw it, so only the
  // child's own work is left to review.
  expect(await repo.cabaret("diff", "--change", "child", "parent.txt")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("diff", "--change", "child", "child.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "-1,0 +1,1
    +|child work
    ",
    }
  `);
});

test("rebase replays only the child's commits and records the new base", async () => {
  const repo = await makeStack();
  const oldBase = await repo.git("rev-parse", "parent");
  await amendParent(repo);
  const newBase = await repo.git("rev-parse", "parent");
  await repo.git("checkout", "-q", "child");
  expect(await repo.cabaret("rebase")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.git("log", "--format=%s", "child")).toBe("child work\nparent work, amended\nroot");
  expect(await repo.git("show", "child:parent.txt")).toBe("parent v2");
  expect(await repo.cabaret("log", "child")).toEqual({
    stdout:
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-parent","parent":"parent"}}\n' +
      `{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-base","base":"${oldBase}"}}\n` +
      '{"timestamp":1748000000005,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      `{"timestamp":1748000000006,"user":"alice@example.com","action":{"kind":"set-base","base":"${newBase}"}}\n`,
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("diff", "--change", "child", "parent.txt")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
});

test("rebase is a no-op when the change already sits on the parent's tip", async () => {
  const repo = await makeStack();
  const before = await repo.cabaret("log", "child");
  expect(await repo.cabaret("rebase", "child")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("log", "child")).toEqual(before);
});

test("rebase pins the base after an out-of-band rebase, surviving a later parent rewrite", async () => {
  const repo = await makeStack();
  await repo.git("checkout", "-q", "parent");
  await repo.write("island.txt", "more parent work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "more parent work");
  await repo.git("checkout", "-q", "child");
  await repo.git("rebase", "-q", "parent");
  const createdBase = await repo.git("rev-parse", "child~2");
  const advanced = await repo.git("rev-parse", "parent");
  // The child sits on the parent's tip, so there is nothing to replay; but
  // rebase must still pin the base there, since the merge-base alone would
  // slide back once the parent is rewritten.
  expect(await repo.cabaret("rebase", "child")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("log", "child")).toEqual({
    stdout:
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-parent","parent":"parent"}}\n' +
      `{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-base","base":"${createdBase}"}}\n` +
      '{"timestamp":1748000000005,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      `{"timestamp":1748000000006,"user":"alice@example.com","action":{"kind":"set-base","base":"${advanced}"}}\n`,
    stderr: "",
    exitCode: 0,
  });
  // Rewrite the parent's tip; without the pinned base the merge-base would
  // fall back and pull the parent's commits into the child's diff.
  await repo.git("checkout", "-q", "parent");
  await repo.write("island.txt", "more parent work, amended\n");
  await repo.git("commit", "-qa", "--amend", "-m", "more parent work, amended");
  expect(await repo.cabaret("diff", "--change", "child", "island.txt")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
});

test("rebase stops on conflict without recording a base", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "parent");
  await repo.git("checkout", "-q", "parent");
  await repo.write("shared.txt", "from parent\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "parent work");
  await repo.cabaret("create", "child");
  await repo.git("checkout", "-q", "child");
  await repo.write("shared.txt", "from child\n");
  await repo.git("commit", "-qam", "child work");
  const before = await repo.cabaret("log", "child");
  await repo.git("checkout", "-q", "parent");
  await repo.write("shared.txt", "from parent, amended\n");
  await repo.git("commit", "-qa", "--amend", "-m", "parent work, amended");
  const result = await repo.cabaret("rebase", "child");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("git rebase");
  expect(await repo.cabaret("log", "child")).toEqual(before);
});

test("rebase fails on a change that does not exist", async () => {
  const repo = await makeRepo();
  await repo.git("branch", "orphan");
  expect(await repo.cabaret("rebase", "orphan")).toEqual({
    stdout: "",
    stderr:
      'change does not exist: "orphan"; run `cabaret create`, or `cabaret gh pull` to import open forge changes\n',
    exitCode: 1,
  });
});

test("a range rebases each change onto its parent, ancestormost first", async () => {
  const repo = await makeRepo();
  const root = await repo.git("rev-parse", "main");
  await addChange(repo, "a");
  const aOld = await repo.git("rev-parse", "a");
  await addChange(repo, "b");
  const bOld = await repo.git("rev-parse", "b");
  await addChange(repo, "c");
  await repo.git("checkout", "-q", "main");
  await repo.write("trunk.txt", "trunk work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "trunk work");
  const mainNew = await repo.git("rev-parse", "main");
  expect(await repo.cabaret("rebase", "main..c")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.git("log", "--format=%s", "c")).toBe("c work\nb work\na work\ntrunk work\nroot");
  // Each change's recorded base is its parent's rebased tip.
  const [aNew, bNew] = [await repo.git("rev-parse", "a"), await repo.git("rev-parse", "b")];
  expect(await repo.cabaret("log", "a")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${root}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      `{"timestamp":1748000000009,"user":"alice@example.com","action":{"kind":"set-base","base":"${mainNew}"}}\n`,
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("log", "b")).toEqual({
    stdout:
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-parent","parent":"a"}}\n' +
      `{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-base","base":"${aOld}"}}\n` +
      '{"timestamp":1748000000005,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      `{"timestamp":1748000000010,"user":"alice@example.com","action":{"kind":"set-base","base":"${aNew}"}}\n`,
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("log", "c")).toEqual({
    stdout:
      '{"timestamp":1748000000006,"user":"alice@example.com","action":{"kind":"set-parent","parent":"b"}}\n' +
      `{"timestamp":1748000000007,"user":"alice@example.com","action":{"kind":"set-base","base":"${bOld}"}}\n` +
      '{"timestamp":1748000000008,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      `{"timestamp":1748000000011,"user":"alice@example.com","action":{"kind":"set-base","base":"${bNew}"}}\n`,
    stderr: "",
    exitCode: 0,
  });
});

test("a range stops at a conflict and a rerun resumes past it", async () => {
  const repo = await makeRepo();
  await addChange(repo, "a");
  await addChange(repo, "b");
  await addChange(repo, "c");
  // The trunk claims b.txt too, so replaying b conflicts.
  await repo.git("checkout", "-q", "main");
  await repo.write("b.txt", "trunk version\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "trunk claims b.txt");
  const result = await repo.cabaret("rebase", "main..c");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("git rebase");
  // a made it onto the new trunk before the stop; c never moved.
  expect(await repo.git("log", "--format=%s", "a")).toBe("a work\ntrunk claims b.txt\nroot");
  expect(await repo.git("log", "--format=%s", "c")).toBe("c work\nb work\na work\nroot");
  // Finish b's rebase with git, then rerun the range: a is already in place,
  // b needs only its base pinned, and c replays.
  await repo.write("b.txt", "b work\n");
  await repo.git("add", "b.txt");
  await repo.git("-c", "core.editor=true", "rebase", "--continue");
  expect(await repo.cabaret("rebase", "main..c")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.git("log", "--format=%s", "c")).toBe("c work\nb work\na work\ntrunk claims b.txt\nroot");
});

test("a range skips a landed change instead of failing", async () => {
  const repo = await makeStack();
  await repo.cabaret("land", "parent");
  const before = await repo.cabaret("log", "child");
  expect(await repo.cabaret("rebase", "main..child")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("log", "child")).toEqual(before);
});

test("a range whose left endpoint is not an ancestor fails", async () => {
  const repo = await makeRepo();
  await addChange(repo, "a");
  await repo.git("checkout", "-q", "main");
  await addChange(repo, "solo");
  expect(await repo.cabaret("rebase", "a..solo")).toEqual({
    stdout: "",
    stderr: '"a" is not an ancestor of "solo": the parent chain stops at "main", which is not a change\n',
    exitCode: 1,
  });
});

test("a malformed range is rejected", async () => {
  const repo = await makeRepo();
  for (const raw of ["a..b..c", "a...b", "..b", "a.."]) {
    expect(await repo.cabaret("rebase", raw)).toEqual({
      stdout: "",
      stderr: `Failed to parse ${JSON.stringify(raw)} for change: not a change or ancestor..descendant range: ${JSON.stringify(raw)}\n`,
      // Stricli's exit code for arguments that fail to scan.
      exitCode: -4,
    });
  }
});

test("a review survives the parent being rewritten and the rebase that follows", async () => {
  const repo = await makeStack();
  await repo.cabaret("review", "child.txt");
  await amendParent(repo);
  // The base is unchanged by the parent's rewrite, so the review still stands.
  expect(await repo.cabaret("diff", "--change", "child", "child.txt")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  // The rebase moves the base, but neither base has child.txt, so the
  // reviewed 2-way diff is still sound and the review stands.
  await repo.cabaret("rebase", "child");
  expect(await repo.cabaret("diff", "--change", "child", "child.txt")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
});

import { expect, test } from "vitest";
import { makeRepo, type TestRepo } from "./fixture.js";

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
      "stdout": "/dev/null
    new/child.txt
    -1,0 +1,1
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
  const result = await repo.cabaret("rebase", "orphan");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('change does not exist: "orphan"; run `cabaret create` first');
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

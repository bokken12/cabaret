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

test("land merges the child into its parent with a marked merge commit", async () => {
  const repo = await makeStack();
  const childTip = await repo.git("rev-parse", "child");
  const parentTip = await repo.git("rev-parse", "parent");
  expect(await repo.cabaret("land")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  // The land advances the parent by exactly the merge, without moving HEAD.
  expect(await repo.git("symbolic-ref", "--short", "HEAD")).toBe("child");
  const merge = await repo.git("rev-parse", "parent");
  expect(await repo.git("rev-parse", "parent^1", "parent^2")).toBe(`${parentTip}\n${childTip}`);
  expect(await repo.git("log", "--format=%B", "-1", "parent")).toBe("Land child\n\nCabaret-Landed: child");
  expect(await repo.git("show", "parent:child.txt")).toBe("child work");
  expect(await repo.cabaret("log", "child")).toEqual({
    stdout:
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-parent","parent":"parent"}}\n' +
      `{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-base","base":"${parentTip}"}}\n` +
      '{"timestamp":1748000000005,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      `{"timestamp":1748000000006,"user":"alice@example.com","action":{"kind":"land","merge":"${merge}"}}\n`,
    stderr: "",
    exitCode: 0,
  });
});

test("land refuses a change that is not based on its parent's tip", async () => {
  const repo = await makeStack();
  await repo.git("checkout", "-q", "parent");
  await repo.write("parent.txt", "parent v2\n");
  await repo.git("commit", "-qam", "more parent work");
  const result = await repo.cabaret("land", "child");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('"child" is not based on the tip of "parent"; run `cabaret rebase` first');
});

test("land refuses a change with no commits of its own", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "idle");
  const result = await repo.cabaret("land", "idle");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('nothing to land: "idle" has no commits of its own');
});

test("land refuses a change that already landed", async () => {
  const repo = await makeStack();
  await repo.cabaret("land", "child");
  const result = await repo.cabaret("land", "child");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('change has landed: "child"');
});

test("land refuses a parent that itself landed", async () => {
  const repo = await makeStack();
  await repo.cabaret("land", "child");
  await repo.cabaret("land", "parent");
  await repo.cabaret("create", "late", "--parent", "parent");
  await repo.git("checkout", "-q", "late");
  await repo.write("late.txt", "late work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "late work");
  const result = await repo.cabaret("land", "late");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('change has landed: "parent"');
});

test("land requires ownership, with the usual override", async () => {
  const repo = await makeStack();
  await repo.cabaret("owner", "transfer", "bob@example.com", "--change", "child");
  const denied = await repo.cabaret("land", "child");
  expect(denied.exitCode).toBe(1);
  expect(denied.stderr).toContain('"child" is owned by "bob@example.com"');
  expect(await repo.cabaret("land", "child", "--even-though-not-owner")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
});

test("a landed change refuses rebase, reparent, and owner transfer", async () => {
  const repo = await makeStack();
  await repo.cabaret("land", "child");
  for (const argv of [
    ["rebase", "child"],
    ["reparent", "child", "main"],
    ["owner", "transfer", "bob@example.com", "--change", "child"],
  ]) {
    const result = await repo.cabaret(...argv);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('change has landed: "child"');
  }
});

test("the diff a land merge brings into the parent needs no review", async () => {
  const repo = await makeStack();
  await repo.cabaret("land");
  // child.txt arrived through the land merge, reviewed under the child's log.
  expect(await repo.cabaret("diff", "--change", "parent", "child.txt")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
});

test("a review made before a land still stands after it", async () => {
  const repo = await makeStack();
  await repo.cabaret("review", "parent.txt", "--change", "parent");
  await repo.cabaret("land", "child");
  expect(await repo.cabaret("diff", "--change", "parent", "parent.txt")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
});

test("parent work on both sides of a land renders one diff per span", async () => {
  const repo = await makeStack();
  await repo.cabaret("land");
  await repo.git("checkout", "-q", "parent");
  await repo.write("parent.txt", "parent v1\nparent v2\n");
  await repo.git("commit", "-qam", "more parent work");
  expect(await repo.cabaret("diff", "--change", "parent", "parent.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "/dev/null
    new/parent.txt
    -1,0 +1,1
    +|parent v1

    old/parent.txt
    new/parent.txt
    -1,1 +1,2
      parent v1
    +|parent v2
    ",
    }
  `);
  // Reviewing marks the whole file, spans and all.
  await repo.cabaret("review", "parent.txt", "--change", "parent");
  expect(await repo.cabaret("diff", "--change", "parent", "parent.txt")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
});

test("a review between two lands leaves only the later span", async () => {
  const repo = await makeStack();
  await repo.cabaret("land");
  await repo.git("checkout", "-q", "parent");
  await repo.write("parent.txt", "parent v1\nparent v2\n");
  await repo.git("commit", "-qam", "more parent work");
  await repo.cabaret("review", "parent.txt", "--change", "parent");
  await repo.cabaret("create", "sibling", "--parent", "parent");
  await repo.git("checkout", "-q", "sibling");
  await repo.write("sibling.txt", "sibling work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "sibling work");
  await repo.cabaret("land");
  await repo.git("checkout", "-q", "parent");
  await repo.write("parent.txt", "parent v1\nparent v2\nparent v3\n");
  await repo.git("commit", "-qam", "even more parent work");
  expect(await repo.cabaret("diff", "--change", "parent", "sibling.txt")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("diff", "--change", "parent", "parent.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "old/parent.txt
    new/parent.txt
    -1,2 +1,3
      parent v1
      parent v2
    +|parent v3
    ",
    }
  `);
});

test("landing with the parent checked out carries its working tree along", async () => {
  const repo = await makeStack();
  await repo.git("checkout", "-q", "parent");
  expect(await repo.cabaret("land", "child")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.git("symbolic-ref", "--short", "HEAD")).toBe("parent");
  expect(await repo.git("status", "--porcelain")).toBe("");
  expect(await repo.git("show", "HEAD:child.txt")).toBe("child work");
});

test("land into a plain branch that is not a change", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "feature");
  await repo.git("checkout", "-q", "feature");
  await repo.write("feature.txt", "feature work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "feature work");
  expect(await repo.cabaret("land")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  // All fixture commits share one pinned date, so pin the order too.
  expect(await repo.git("log", "--topo-order", "--format=%s", "main")).toBe("Land feature\nfeature work\nroot");
});

test("land after an out-of-band rebase pins the base it validated", async () => {
  const repo = await makeStack();
  const createdBase = await repo.git("rev-parse", "parent");
  await repo.git("checkout", "-q", "parent");
  await repo.write("parent.txt", "parent v2\n");
  await repo.git("commit", "-qam", "more parent work");
  const advanced = await repo.git("rev-parse", "parent");
  await repo.git("checkout", "-q", "child");
  await repo.git("rebase", "-q", "parent");
  expect(await repo.cabaret("land")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  const merge = await repo.git("rev-parse", "parent");
  expect(await repo.cabaret("log", "child")).toEqual({
    stdout:
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-parent","parent":"parent"}}\n' +
      `{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-base","base":"${createdBase}"}}\n` +
      '{"timestamp":1748000000005,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      `{"timestamp":1748000000006,"user":"alice@example.com","action":{"kind":"set-base","base":"${advanced}"}}\n` +
      `{"timestamp":1748000000007,"user":"alice@example.com","action":{"kind":"land","merge":"${merge}"}}\n`,
    stderr: "",
    exitCode: 0,
  });
  // The pinned base keeps the frozen change's diff to its own work.
  expect(await repo.cabaret("diff", "--change", "child", "parent.txt")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
});

test("a cherry-picked land merge still needs review", async () => {
  const repo = await makeStack();
  await repo.cabaret("land");
  // The cherry-pick copies the land merge's message, trailer included, onto
  // an ordinary single-parent commit; only a true merge marks a landing.
  await repo.cabaret("create", "copy", "--parent", "main");
  await repo.git("checkout", "-q", "copy");
  await repo.git("cherry-pick", "-m", "1", "parent");
  expect(await repo.cabaret("diff", "child.txt")).toMatchInlineSnapshot(`
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

test("a merge without the land trailer still needs review", async () => {
  const repo = await makeStack();
  await repo.git("checkout", "-q", "parent");
  await repo.git("merge", "--no-ff", "-m", "merge child by hand", "child");
  expect(await repo.cabaret("diff", "--change", "parent", "child.txt")).toMatchInlineSnapshot(`
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

test("a landed change can still be reviewed and forgotten", async () => {
  const repo = await makeStack();
  await repo.cabaret("land", "child");
  expect(await repo.cabaret("review", "child.txt", "--change", "child")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("diff", "--change", "child", "child.txt")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("forget", "child.txt", "--change", "child")).toEqual({
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

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

test("land merges the child into its parent with a marked merge commit", async () => {
  const repo = await makeStack();
  const childTip = await repo.git("rev-parse", "child");
  const parentTip = await repo.git("rev-parse", "parent");
  await repo.cabaret("review", "child.txt");
  expect(await repo.cabaret("land")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  // The land advances the parent by exactly the merge, without moving HEAD.
  expect(await repo.git("symbolic-ref", "--short", "HEAD")).toBe("child");
  const merge = await repo.git("rev-parse", "parent");
  expect(await repo.git("rev-parse", "parent^1", "parent^2")).toBe(`${parentTip}\n${childTip}`);
  expect(await repo.git("log", "--format=%B", "-1", "parent")).toBe("Land child\n\nCabaret-Landed: child");
  expect(await repo.git("show", "parent:child.txt")).toBe("child work");
  expect(await repo.cabaret("log", "child")).toEqual({
    stdout:
      '{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-parent","parent":"parent"}}\n' +
      `{"timestamp":1748000000005,"user":"alice@example.com","action":{"kind":"set-base","base":"${parentTip}"}}\n` +
      '{"timestamp":1748000000006,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000007,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      `{"timestamp":1748000000008,"user":"alice@example.com","action":{"kind":"review","file":"child.txt","base":"${parentTip}","tip":"${childTip}"}}\n` +
      `{"timestamp":1748000000009,"user":"alice@example.com","action":{"kind":"land","merge":"${merge}"}}\n`,
    stderr: "",
    exitCode: 0,
  });
});

test("land takes a change behind its parent when it merges cleanly", async () => {
  const repo = await makeStack();
  const childTip = await repo.git("rev-parse", "child");
  const createdBase = await repo.git("rev-parse", "parent");
  await repo.git("checkout", "-q", "parent");
  await repo.write("parent.txt", "parent v2\n");
  await repo.git("commit", "-qam", "more parent work");
  const advanced = await repo.git("rev-parse", "parent");
  expect(await repo.cabaret("land", "child", "--even-though-unreviewed")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  // The land merge sits on the parent's new tip and carries both sides' work.
  expect(await repo.git("rev-parse", "parent^1", "parent^2")).toBe(`${advanced}\n${childTip}`);
  expect(await repo.git("show", "parent:parent.txt")).toBe("parent v2");
  expect(await repo.git("show", "parent:child.txt")).toBe("child work");
  // The base stays where the reviewed diff was computed, not the tip landed onto.
  const merge = await repo.git("rev-parse", "parent");
  expect(await repo.cabaret("log", "child")).toEqual({
    stdout:
      '{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-parent","parent":"parent"}}\n' +
      `{"timestamp":1748000000005,"user":"alice@example.com","action":{"kind":"set-base","base":"${createdBase}"}}\n` +
      '{"timestamp":1748000000006,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000007,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      `{"timestamp":1748000000008,"user":"alice@example.com","action":{"kind":"land","merge":"${merge}"}}\n`,
    stderr: "",
    exitCode: 0,
  });
});

test("land squashes a change behind its parent to the merged tree", async () => {
  const repo = await makeStack();
  await repo.git("config", "cabaret.landMethod", "squash");
  await repo.git("checkout", "-q", "parent");
  await repo.write("parent.txt", "parent v2\n");
  await repo.git("commit", "-qam", "more parent work");
  const advanced = await repo.git("rev-parse", "parent");
  expect(await repo.cabaret("land", "child", "--even-though-unreviewed")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  // The squash's sole parent is the advanced tip, and its tree keeps the
  // parent's own work rather than rewinding it to the child's stale copy.
  expect(await repo.git("show", "--no-patch", "--format=%P", "parent")).toBe(advanced);
  expect(await repo.git("show", "parent:parent.txt")).toBe("parent v2");
  expect(await repo.git("show", "parent:child.txt")).toBe("child work");
});

test("land refuses a change that conflicts with its parent's tip", async () => {
  const repo = await makeStack();
  await repo.git("checkout", "-q", "parent");
  await repo.write("child.txt", "parent's own child.txt\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qam", "parent claims child.txt");
  const parentTip = await repo.git("rev-parse", "parent");
  expect(await repo.cabaret("land", "child")).toEqual({
    stdout: "",
    stderr: '"child" conflicts with the tip of "parent" in child.txt; run `cabaret rebase` first\n',
    exitCode: 1,
  });
  expect(await repo.git("rev-parse", "parent")).toBe(parentTip);
});

test("land refuses a change with no commits of its own", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "idle");
  expect(await repo.cabaret("land", "idle")).toEqual({
    stdout: "",
    stderr: 'nothing to land: "idle" has no commits of its own\n',
    exitCode: 1,
  });
});

test("land refuses a change that already landed", async () => {
  const repo = await makeStack();
  await repo.cabaret("land", "child", "--even-though-unreviewed");
  const merge = await repo.git("rev-parse", "parent");
  expect(await repo.cabaret("land", "child")).toEqual({
    stdout: "",
    stderr: `change has landed: "child" (merge ${merge})\n`,
    exitCode: 1,
  });
});

test("land refuses a parent that itself landed", async () => {
  const repo = await makeStack();
  await repo.cabaret("land", "child", "--even-though-unreviewed");
  await repo.cabaret("land", "parent", "--even-though-unreviewed");
  const merge = await repo.git("rev-parse", "main");
  await repo.cabaret("create", "late", "--parent", "parent");
  await repo.git("checkout", "-q", "late");
  await repo.write("late.txt", "late work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "late work");
  expect(await repo.cabaret("land", "late")).toEqual({
    stdout: "",
    stderr: `change has landed: "parent" (merge ${merge})\n`,
    exitCode: 1,
  });
});

test("land requires ownership, with the usual override", async () => {
  const repo = await makeStack();
  await repo.cabaret("set-owner", "bob@example.com", "--change", "child");
  expect(await repo.cabaret("land", "child")).toEqual({
    stdout: "",
    stderr:
      '"child" is owned by "bob@example.com", not "alice@example.com"; pass --even-though-not-owner to override\n',
    exitCode: 1,
  });
  // Skipping the ownership check does not skip the owner's obligations.
  expect(await repo.cabaret("land", "child", "--even-though-not-owner")).toEqual({
    stdout: "",
    stderr:
      "review obligations are unsatisfied; pass --even-though-unreviewed to override:\n" +
      "  child.txt: 1 more of bob@example.com (owner)\n",
    exitCode: 1,
  });
  expect(await repo.cabaret("land", "child", "--even-though-not-owner", "--even-though-unreviewed")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
});

test("a landed change refuses rebase, reparent, and set-owner", async () => {
  const repo = await makeStack();
  await repo.cabaret("land", "child", "--even-though-unreviewed");
  const merge = await repo.git("rev-parse", "parent");
  for (const argv of [
    ["rebase", "child"],
    ["reparent", "child", "main"],
    ["set-owner", "bob@example.com", "--change", "child"],
  ]) {
    expect(await repo.cabaret(...argv)).toEqual({
      stdout: "",
      stderr: `change has landed: "child" (merge ${merge})\n`,
      exitCode: 1,
    });
  }
});

test("the diff a land merge brings into the parent needs no review", async () => {
  const repo = await makeStack();
  await repo.cabaret("land", "--even-though-unreviewed");
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
  await repo.cabaret("land", "child", "--even-though-unreviewed");
  expect(await repo.cabaret("diff", "--change", "parent", "parent.txt")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
});

test("parent work on both sides of a land renders one diff per span", async () => {
  const repo = await makeStack();
  await repo.cabaret("land", "--even-though-unreviewed");
  await repo.git("checkout", "-q", "parent");
  await repo.write("parent.txt", "parent v1\nparent v2\n");
  await repo.git("commit", "-qam", "more parent work");
  expect(await repo.cabaret("diff", "--change", "parent", "parent.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "-1,0 +1,1
    +|parent v1

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
  await repo.cabaret("land", "--even-though-unreviewed");
  await repo.git("checkout", "-q", "parent");
  await repo.write("parent.txt", "parent v1\nparent v2\n");
  await repo.git("commit", "-qam", "more parent work");
  await repo.cabaret("review", "parent.txt", "--change", "parent");
  await repo.cabaret("create", "sibling", "--parent", "parent");
  await repo.git("checkout", "-q", "sibling");
  await repo.write("sibling.txt", "sibling work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "sibling work");
  await repo.cabaret("land", "--even-though-unreviewed");
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
      "stdout": "-1,2 +1,3
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
  expect(await repo.cabaret("land", "child", "--even-though-unreviewed")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
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
  expect(await repo.cabaret("land", "--even-though-unreviewed")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
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
  expect(await repo.cabaret("land", "--even-though-unreviewed")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  const merge = await repo.git("rev-parse", "parent");
  expect(await repo.cabaret("log", "child")).toEqual({
    stdout:
      '{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-parent","parent":"parent"}}\n' +
      `{"timestamp":1748000000005,"user":"alice@example.com","action":{"kind":"set-base","base":"${createdBase}"}}\n` +
      '{"timestamp":1748000000006,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000007,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      `{"timestamp":1748000000008,"user":"alice@example.com","action":{"kind":"set-base","base":"${advanced}"}}\n` +
      `{"timestamp":1748000000009,"user":"alice@example.com","action":{"kind":"land","merge":"${merge}"}}\n`,
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

test("a cherry-picked land commit is skipped like the land it copies", async () => {
  const repo = await makeStack();
  await repo.cabaret("land", "--even-though-unreviewed");
  // The cherry-pick copies the land merge's message, trailer included, onto
  // an ordinary single-parent commit — the same shape as a squash land, so
  // its diff is skipped as already reviewed: it was, where it landed.
  await repo.cabaret("create", "copy", "--parent", "main");
  await repo.git("checkout", "-q", "copy");
  await repo.git("cherry-pick", "-m", "1", "parent");
  expect(await repo.cabaret("diff", "child.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "",
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
      "stdout": "-1,0 +1,1
    +|child work
    ",
    }
  `);
});

test("a range lands the whole chain, deepest first", async () => {
  const repo = await makeRepo();
  const root = await repo.git("rev-parse", "main");
  await addChange(repo, "a");
  const aTip = await repo.git("rev-parse", "a");
  await addChange(repo, "b");
  const bTip = await repo.git("rev-parse", "b");
  await addChange(repo, "c");
  expect(await repo.cabaret("land", "main..c", "--even-though-unreviewed")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  // Each parent advanced by exactly its child's land merge, so main holds it all.
  expect(await repo.git("log", "--format=%s", "--first-parent", "main")).toBe("Land a\nroot");
  expect(await repo.git("log", "--format=%s", "--first-parent", "a")).toBe("Land b\na work\nroot");
  expect(await repo.git("log", "--format=%s", "--first-parent", "b")).toBe("Land c\nb work\na work\nroot");
  expect(await repo.git("show", "main:c.txt")).toBe("c work");
  const [mergeA, mergeB, mergeC] = [
    await repo.git("rev-parse", "main"),
    await repo.git("rev-parse", "a"),
    await repo.git("rev-parse", "b"),
  ];
  expect(await repo.cabaret("log", "a")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${root}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      `{"timestamp":1748000000014,"user":"alice@example.com","action":{"kind":"land","merge":"${mergeA}"}}\n`,
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("log", "b")).toEqual({
    stdout:
      '{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-parent","parent":"a"}}\n' +
      `{"timestamp":1748000000005,"user":"alice@example.com","action":{"kind":"set-base","base":"${aTip}"}}\n` +
      '{"timestamp":1748000000006,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000007,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      `{"timestamp":1748000000013,"user":"alice@example.com","action":{"kind":"land","merge":"${mergeB}"}}\n`,
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("log", "c")).toEqual({
    stdout:
      '{"timestamp":1748000000008,"user":"alice@example.com","action":{"kind":"set-parent","parent":"b"}}\n' +
      `{"timestamp":1748000000009,"user":"alice@example.com","action":{"kind":"set-base","base":"${bTip}"}}\n` +
      '{"timestamp":1748000000010,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000011,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      `{"timestamp":1748000000012,"user":"alice@example.com","action":{"kind":"land","merge":"${mergeC}"}}\n`,
    stderr: "",
    exitCode: 0,
  });
});

test("a range stops at a failure and a rerun resumes past the landed prefix", async () => {
  const repo = await makeRepo();
  await addChange(repo, "a");
  await addChange(repo, "b");
  await addChange(repo, "c");
  await repo.cabaret("set-owner", "bob@example.com", "--change", "b");
  expect(await repo.cabaret("land", "main..c", "--even-though-unreviewed")).toEqual({
    stdout: "",
    stderr: '"b" is owned by "bob@example.com", not "alice@example.com"; pass --even-though-not-owner to override\n',
    exitCode: 1,
  });
  // c landed into b before the stop; nothing above it moved.
  expect(await repo.git("log", "--format=%s", "--first-parent", "b")).toBe("Land c\nb work\na work\nroot");
  expect(await repo.git("log", "--format=%s", "--first-parent", "main")).toBe("root");
  // The rerun skips the landed c and finishes the chain.
  expect(await repo.cabaret("land", "main..c", "--even-though-not-owner", "--even-though-unreviewed")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("log", "--format=%s", "--first-parent", "main")).toBe("Land a\nroot");
  expect(await repo.git("show", "main:c.txt")).toBe("c work");
});

test("a range that would land into a landed change refuses before landing anything", async () => {
  const repo = await makeRepo();
  await addChange(repo, "a");
  await addChange(repo, "b");
  await addChange(repo, "c");
  await repo.cabaret("land", "a", "--even-though-unreviewed");
  // The land moved b onto main; hanging it back under the landed a jams the chain.
  await repo.cabaret("reparent", "b", "a");
  expect(await repo.cabaret("land", "main..c")).toEqual({
    stdout: "",
    stderr: '"b" would land into "a", which has landed; run `cabaret reparent` first\n',
    exitCode: 1,
  });
  // Nothing moved: landing c first would only bury it in the jammed chain.
  expect(await repo.git("log", "--format=%s", "--first-parent", "b")).toBe("b work\na work\nroot");
});

test("landing a change reparents its children onto where it landed", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  const gadgetTip = await repo.git("rev-parse", "gadget");
  await addChange(repo, "gizmo");
  await repo.cabaret("create", "widget", "--parent", "gadget");
  expect(await repo.cabaret("land", "gadget", "--even-though-unreviewed")).toEqual({
    stdout: 'reparented "gizmo" onto "main"\nreparented "widget" onto "main"\n',
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("log", "gizmo")).toEqual({
    stdout:
      '{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-parent","parent":"gadget"}}\n' +
      `{"timestamp":1748000000005,"user":"alice@example.com","action":{"kind":"set-base","base":"${gadgetTip}"}}\n` +
      '{"timestamp":1748000000006,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000007,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      '{"timestamp":1748000000013,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n',
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("log", "widget")).toEqual({
    stdout:
      '{"timestamp":1748000000008,"user":"alice@example.com","action":{"kind":"set-parent","parent":"gadget"}}\n' +
      `{"timestamp":1748000000009,"user":"alice@example.com","action":{"kind":"set-base","base":"${gadgetTip}"}}\n` +
      '{"timestamp":1748000000010,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000011,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      '{"timestamp":1748000000014,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

test("landing leaves landed children where they landed", async () => {
  const repo = await makeStack();
  const parentTip = await repo.git("rev-parse", "parent");
  await repo.cabaret("land", "child", "--even-though-unreviewed");
  const childMerge = await repo.git("rev-parse", "parent");
  expect(await repo.cabaret("land", "parent", "--even-though-unreviewed")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  // The landed child's parent stays the frozen history it landed into.
  expect(await repo.cabaret("log", "child")).toEqual({
    stdout:
      '{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-parent","parent":"parent"}}\n' +
      `{"timestamp":1748000000005,"user":"alice@example.com","action":{"kind":"set-base","base":"${parentTip}"}}\n` +
      '{"timestamp":1748000000006,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000007,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      `{"timestamp":1748000000008,"user":"alice@example.com","action":{"kind":"land","merge":"${childMerge}"}}\n`,
    stderr: "",
    exitCode: 0,
  });
});

test("landing into its own child leaves the cycle for a manual reparent", async () => {
  const repo = await makeRepo();
  await addChange(repo, "outer");
  const outerTip = await repo.git("rev-parse", "outer");
  await addChange(repo, "inner");
  await repo.git("checkout", "-q", "outer");
  await repo.write("outer2.txt", "more outer work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "more outer work");
  // outer→inner→outer: landing outer merges it into inner, but moving inner
  // onto itself would knot the cycle tighter, so it stays put.
  await repo.cabaret("reparent", "outer", "inner");
  expect(await repo.cabaret("land", "outer", "--even-though-unreviewed")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("log", "inner")).toEqual({
    stdout:
      '{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-parent","parent":"outer"}}\n' +
      `{"timestamp":1748000000005,"user":"alice@example.com","action":{"kind":"set-base","base":"${outerTip}"}}\n` +
      '{"timestamp":1748000000006,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000007,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

test("a range land carries an outside child down with each landing", async () => {
  const repo = await makeRepo();
  await addChange(repo, "a");
  await addChange(repo, "b");
  const bTip = await repo.git("rev-parse", "b");
  await repo.cabaret("create", "d", "--parent", "b");
  expect(await repo.cabaret("land", "main..b", "--even-though-unreviewed")).toEqual({
    stdout: 'reparented "d" onto "a"\nreparented "d" onto "main"\n',
    stderr: "",
    exitCode: 0,
  });
  // d followed its code: onto a when b landed there, onto main when a landed.
  expect(await repo.cabaret("log", "d")).toEqual({
    stdout:
      '{"timestamp":1748000000008,"user":"alice@example.com","action":{"kind":"set-parent","parent":"b"}}\n' +
      `{"timestamp":1748000000009,"user":"alice@example.com","action":{"kind":"set-base","base":"${bTip}"}}\n` +
      '{"timestamp":1748000000010,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000011,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      '{"timestamp":1748000000013,"user":"alice@example.com","action":{"kind":"set-parent","parent":"a"}}\n' +
      '{"timestamp":1748000000015,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n',
    stderr: "",
    exitCode: 0,
  });
});

test("a landed change can still be reviewed and forgotten", async () => {
  const repo = await makeStack();
  await repo.cabaret("land", "child", "--even-though-unreviewed");
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
      "stdout": "-1,0 +1,1
    +|child work
    ",
    }
  `);
});

test("land squashes locally when cabaret.landMethod is squash", async () => {
  const repo = await makeStack();
  await repo.git("config", "cabaret.landMethod", "squash");
  const childTip = await repo.git("rev-parse", "child");
  const parentTip = await repo.git("rev-parse", "parent");
  expect(await repo.cabaret("land", "--even-though-unreviewed")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  // The land advances the parent by one commit with the child's tree and no
  // second parent; the log freezes the tip the squash does not carry.
  const squash = await repo.git("rev-parse", "parent");
  expect(await repo.git("show", "--no-patch", "--format=%P", "parent")).toBe(parentTip);
  expect(await repo.git("log", "--format=%B", "-1", "parent")).toBe("Land child\n\nCabaret-Landed: child");
  expect(await repo.git("show", "parent:child.txt")).toBe("child work");
  expect((await repo.cabaret("log", "child")).stdout).toContain(
    `{"kind":"land","merge":"${squash}","tip":"${childTip}"}`,
  );
  // The parent's reviewers skip the squash's diff: it was reviewed in the child.
  expect(await repo.cabaret("diff", "--change", "parent", "child.txt")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  // The landed change still shows its own diff, frozen at the recorded tip.
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

test("a bad cabaret.landMethod fails before anything moves", async () => {
  const repo = await makeStack();
  await repo.git("config", "cabaret.landMethod", "rebase");
  const parentTip = await repo.git("rev-parse", "parent");
  expect(await repo.cabaret("land")).toEqual({
    stdout: "",
    stderr: 'git config cabaret.landMethod must be one of merge, squash: "rebase"\n',
    exitCode: 1,
  });
  expect(await repo.git("rev-parse", "parent")).toBe(parentTip);
});

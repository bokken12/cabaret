import { expect, test } from "vitest";
import { addChange, makeClone, makeRepo, type TestRepo } from "./fixture.js";

/**
 * A repo with change `child` (one commit adding child.txt) stacked on change
 * `parent` (one commit adding parent.txt, self-reviewed unless `markParent`
 * says otherwise so lands into it pass the parent check), both created
 * through cabaret. Leaves HEAD on `child`.
 */
async function makeStack(markParent = true): Promise<TestRepo> {
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
  if (markParent) {
    await repo.cabaret("mark", "--change", "parent", "--tip", "parent", "parent.txt");
  }
  return repo;
}

test("land merges the child into its parent with a marked merge commit", async () => {
  const repo = await makeStack();
  const childTip = await repo.git("rev-parse", "child");
  const parentTip = await repo.git("rev-parse", "parent");
  await repo.cabaret("mark", "--tip", "HEAD", "child.txt");
  expect(await repo.cabaret("land")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  // The land advances the parent by exactly the merge, without moving HEAD.
  expect(await repo.git("symbolic-ref", "--short", "HEAD")).toBe("child");
  const merge = await repo.git("rev-parse", "parent");
  expect(await repo.git("rev-parse", "parent^1", "parent^2")).toBe(`${parentTip}\n${childTip}`);
  expect(await repo.git("log", "--format=%B", "-1", "parent")).toBe("Land child\n\nCabaret-Landed: child");
  expect(await repo.git("show", "parent:child.txt")).toBe("child work");
  expect(await repo.cabaret("dev", "log", "child")).toEqual({
    stdout:
      '{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-parent","parent":"parent"}}\n' +
      `{"timestamp":1748000000005,"user":"alice@example.com","action":{"kind":"set-base","base":"${parentTip}"}}\n` +
      '{"timestamp":1748000000006,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000007,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      `{"timestamp":1748000000009,"user":"alice@example.com","action":{"kind":"review","file":"child.txt","base":"${parentTip}","tip":"${childTip}"}}\n` +
      `{"timestamp":1748000000010,"user":"alice@example.com","action":{"kind":"land","merge":"${merge}"}}\n`,
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
  expect(await repo.cabaret("land", "child", "--even-though-unreviewed", "--even-though-parent-unreviewed")).toEqual({
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
  expect(await repo.cabaret("dev", "log", "child")).toEqual({
    stdout:
      '{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-parent","parent":"parent"}}\n' +
      `{"timestamp":1748000000005,"user":"alice@example.com","action":{"kind":"set-base","base":"${createdBase}"}}\n` +
      '{"timestamp":1748000000006,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000007,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      `{"timestamp":1748000000009,"user":"alice@example.com","action":{"kind":"land","merge":"${merge}"}}\n`,
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
  expect(await repo.cabaret("land", "child", "--even-though-unreviewed", "--even-though-parent-unreviewed")).toEqual({
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
    stderr: '"child" conflicts with the tip of "parent" in child.txt; run `cab rebase` first\n',
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
  expect(await repo.cabaret("review", "--change", "parent", "child.txt")).toEqual({
    stdout: "child.txt in parent\n\nNothing left to review.\n",
    stderr: "",
    exitCode: 0,
  });
});

test("a review made before a land still stands after it", async () => {
  const repo = await makeStack();
  await repo.cabaret("mark", "--tip", "parent", "parent.txt", "--change", "parent");
  await repo.cabaret("land", "child", "--even-though-unreviewed");
  expect(await repo.cabaret("review", "--change", "parent", "parent.txt")).toEqual({
    stdout: "parent.txt in parent\n\nNothing left to review.\n",
    stderr: "",
    exitCode: 0,
  });
});

test("parent work on both sides of a land renders one diff per span", async () => {
  const repo = await makeStack(false);
  const round1End = await repo.git("rev-parse", "parent");
  await repo.cabaret("land", "--even-though-unreviewed", "--even-though-parent-unreviewed");
  await repo.git("checkout", "-q", "parent");
  await repo.write("parent.txt", "parent v1\nparent v2\n");
  await repo.git("commit", "-qam", "more parent work");
  expect(await repo.cabaret("review", "--change", "parent", "parent.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "Review parent
    =============

    Reviewing up to 752ee7d4c0d4; 1 more round follows.

      parent.txt

    parent.txt in parent (up to 752ee7d4c0d4; 1 more round follows)

    -1,0 +1,1
    +|parent v1

    Record review of what you have read:
      cabaret mark --change parent --tip 752ee7d4c0d4 parent.txt
    ",
    }
  `);
  // A mark at the first round's end leaves the later round open.
  await repo.cabaret("mark", "--tip", round1End, "parent.txt", "--change", "parent");
  expect((await repo.cabaret("review", "--change", "parent", "parent.txt")).stdout).toContain("+|parent v2");
  await repo.cabaret("mark", "--tip", "parent", "parent.txt", "--change", "parent");
  expect(await repo.cabaret("review", "--change", "parent", "parent.txt")).toEqual({
    stdout: "parent.txt in parent\n\nNothing left to review.\n",
    stderr: "",
    exitCode: 0,
  });
});

test("a file changed only after a land marks at its own round's end", async () => {
  const repo = await makeStack();
  const base = await repo.git("rev-parse", "main");
  await repo.cabaret("land", "--even-though-unreviewed");
  await repo.git("checkout", "-q", "parent");
  await repo.write("late.txt", "late work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "late work");
  const tip = await repo.git("rev-parse", "parent");
  // parent.txt's round is still open, but late.txt is due only past the land.
  expect(await repo.cabaret("mark", "--tip", "parent", "late.txt", "--change", "parent")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("dev", "log", "parent")).stdout).toContain(
    `{"kind":"review","file":"late.txt","base":"${base}","tip":"${tip}"}`,
  );
});

test("a review between two lands leaves only the later span", async () => {
  const repo = await makeStack();
  await repo.cabaret("land", "--even-though-unreviewed");
  await repo.git("checkout", "-q", "parent");
  await repo.write("parent.txt", "parent v1\nparent v2\n");
  await repo.git("commit", "-qam", "more parent work");
  await repo.cabaret("mark", "--tip", "parent", "parent.txt", "--change", "parent");
  await repo.cabaret("create", "sibling", "--parent", "parent");
  await repo.git("checkout", "-q", "sibling");
  await repo.write("sibling.txt", "sibling work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "sibling work");
  await repo.cabaret("land", "--even-though-unreviewed");
  await repo.git("checkout", "-q", "parent");
  await repo.write("parent.txt", "parent v1\nparent v2\nparent v3\n");
  await repo.git("commit", "-qam", "even more parent work");
  expect(await repo.cabaret("review", "--change", "parent", "sibling.txt")).toEqual({
    stdout: "sibling.txt in parent\n\nNothing left to review.\n",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("review", "--change", "parent", "parent.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "Review parent
    =============

    Reviewing up to 0a5396e9799e.

      parent.txt

    parent.txt in parent (up to 0a5396e9799e)

    -1,2 +1,3
      parent v1
      parent v2
    +|parent v3

    Record review of what you have read:
      cabaret mark --change parent --tip 0a5396e9799e parent.txt
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

test("land stands on origin's copy of a parent that is merely behind, and publishes", async () => {
  const repo = await makeRepo();
  await repo.git("push", "-q", "origin", "main");
  await addChange(repo, "feature");
  // A second machine advances origin's main; this clone fetches the news but
  // its own main stays put.
  const other = await makeClone(repo, "bob@example.com");
  await other.git("checkout", "-q", "main");
  await other.write("trunk.txt", "trunk work\n");
  await other.git("add", "-A");
  await other.git("commit", "-qm", "trunk work");
  await other.git("push", "-q", "origin", "main");
  await repo.git("fetch", "-q", "origin");
  const originMain = await repo.git("rev-parse", "origin/main");
  const featureTip = await repo.git("rev-parse", "feature");
  expect(await repo.cabaret("land", "--even-though-unreviewed")).toEqual({
    stdout: 'pushed "main" to origin\n',
    stderr: "",
    exitCode: 0,
  });
  // The merge stands on the freshest reading — origin's trunk work included —
  // and origin accepts the push as a plain advance.
  expect(await repo.git("rev-parse", "main^1", "main^2")).toBe(`${originMain}\n${featureTip}`);
  expect(await repo.git("show", "main:trunk.txt")).toBe("trunk work");
  expect(await repo.git("rev-parse", "origin/main")).toBe(await repo.git("rev-parse", "main"));
});

test("land refuses a diverged parent, moving nothing", async () => {
  const repo = await makeRepo();
  await repo.git("push", "-q", "origin", "main");
  await addChange(repo, "feature");
  // The readings part ways: origin's main gains trunk work while this
  // clone's main takes local work, so no freshest reading exists.
  const other = await makeClone(repo, "bob@example.com");
  await other.git("checkout", "-q", "main");
  await other.write("trunk.txt", "trunk work\n");
  await other.git("add", "-A");
  await other.git("commit", "-qm", "trunk work");
  await other.git("push", "-q", "origin", "main");
  await repo.git("checkout", "-q", "main");
  await repo.write("local.txt", "local work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "local work");
  await repo.git("checkout", "-q", "feature");
  await repo.git("fetch", "-q", "origin");
  const mainBefore = await repo.git("rev-parse", "main");
  const logBefore = await repo.cabaret("dev", "log", "feature");
  expect(await repo.cabaret("land", "--even-though-unreviewed")).toEqual({
    stdout: "",
    stderr: 'local "main" has diverged from origin\'s copy; sync it first\n',
    exitCode: 1,
  });
  expect(await repo.git("rev-parse", "main")).toBe(mainBefore);
  expect(await repo.cabaret("dev", "log", "feature")).toEqual(logBefore);
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
  expect(await repo.cabaret("land", "--even-though-unreviewed", "--even-though-parent-unreviewed")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  const merge = await repo.git("rev-parse", "parent");
  expect(await repo.cabaret("dev", "log", "child")).toEqual({
    stdout:
      '{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-parent","parent":"parent"}}\n' +
      `{"timestamp":1748000000005,"user":"alice@example.com","action":{"kind":"set-base","base":"${createdBase}"}}\n` +
      '{"timestamp":1748000000006,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000007,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      `{"timestamp":1748000000009,"user":"alice@example.com","action":{"kind":"set-base","base":"${advanced}"}}\n` +
      `{"timestamp":1748000000010,"user":"alice@example.com","action":{"kind":"land","merge":"${merge}"}}\n`,
    stderr: "",
    exitCode: 0,
  });
  // The pinned base keeps the frozen change's diff to its own work.
  expect(await repo.cabaret("review", "--change", "child", "parent.txt")).toEqual({
    stdout: "parent.txt in child\n\nNothing left to review.\n",
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
  expect(await repo.cabaret("review", "child.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "child.txt in copy

    Nothing left to review.
    ",
    }
  `);
});

test("a merge without the land trailer still needs review", async () => {
  const repo = await makeStack();
  await repo.git("checkout", "-q", "parent");
  await repo.git("merge", "--no-ff", "-m", "merge child by hand", "child");
  expect(await repo.cabaret("review", "--change", "parent", "child.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "Review parent
    =============

    Reviewing up to 330b997bc88a.

      child.txt

    child.txt in parent (up to 330b997bc88a)

    -1,0 +1,1
    +|child work

    Record review of what you have read:
      cabaret mark --change parent --tip 330b997bc88a child.txt
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
  expect(await repo.cabaret("land", "main..c", "--even-though-unreviewed", "--even-though-parent-unreviewed")).toEqual({
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
  expect(await repo.cabaret("dev", "log", "a")).toEqual({
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${root}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      `{"timestamp":1748000000014,"user":"alice@example.com","action":{"kind":"land","merge":"${mergeA}"}}\n`,
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("dev", "log", "b")).toEqual({
    stdout:
      '{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-parent","parent":"a"}}\n' +
      `{"timestamp":1748000000005,"user":"alice@example.com","action":{"kind":"set-base","base":"${aTip}"}}\n` +
      '{"timestamp":1748000000006,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000007,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      `{"timestamp":1748000000013,"user":"alice@example.com","action":{"kind":"land","merge":"${mergeB}"}}\n`,
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("dev", "log", "c")).toEqual({
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
  expect(await repo.cabaret("land", "main..c", "--even-though-unreviewed", "--even-though-parent-unreviewed")).toEqual({
    stdout: "",
    stderr: '"b" is owned by "bob@example.com", not "alice@example.com"; pass --even-though-not-owner to override\n',
    exitCode: 1,
  });
  // c landed into b before the stop; nothing above it moved.
  expect(await repo.git("log", "--format=%s", "--first-parent", "b")).toBe("Land c\nb work\na work\nroot");
  expect(await repo.git("log", "--format=%s", "--first-parent", "main")).toBe("root");
  // The rerun skips the landed c and finishes the chain.
  expect(
    await repo.cabaret(
      "land",
      "main..c",
      "--even-though-not-owner",
      "--even-though-unreviewed",
      "--even-though-parent-unreviewed",
    ),
  ).toEqual({
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
    stderr: '"b" would land into "a", which has landed; run `cab reparent` first\n',
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
  expect(await repo.cabaret("dev", "log", "gizmo")).toEqual({
    stdout:
      '{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-parent","parent":"gadget"}}\n' +
      `{"timestamp":1748000000005,"user":"alice@example.com","action":{"kind":"set-base","base":"${gadgetTip}"}}\n` +
      '{"timestamp":1748000000006,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000007,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      '{"timestamp":1748000000013,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n',
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("dev", "log", "widget")).toEqual({
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
  expect(await repo.cabaret("dev", "log", "child")).toEqual({
    stdout:
      '{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-parent","parent":"parent"}}\n' +
      `{"timestamp":1748000000005,"user":"alice@example.com","action":{"kind":"set-base","base":"${parentTip}"}}\n` +
      '{"timestamp":1748000000006,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000007,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      `{"timestamp":1748000000009,"user":"alice@example.com","action":{"kind":"land","merge":"${childMerge}"}}\n`,
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
  expect(await repo.cabaret("land", "outer", "--even-though-unreviewed", "--even-though-parent-unreviewed")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("dev", "log", "inner")).toEqual({
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
  expect(await repo.cabaret("land", "main..b", "--even-though-unreviewed", "--even-though-parent-unreviewed")).toEqual({
    stdout: 'reparented "d" onto "a"\nreparented "d" onto "main"\n',
    stderr: "",
    exitCode: 0,
  });
  // d followed its code: onto a when b landed there, onto main when a landed.
  expect(await repo.cabaret("dev", "log", "d")).toEqual({
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
  expect(await repo.cabaret("mark", "--tip", "child", "child.txt", "--change", "child")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("review", "--change", "child", "child.txt")).toEqual({
    stdout: "child.txt in child\n\nNothing left to review.\n",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("forget", "child.txt", "--change", "child")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("review", "--change", "child", "child.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "Review child
    ============

    Reviewing up to 46080b0eb5bb.

      child.txt

    child.txt in child (up to 46080b0eb5bb)

    -1,0 +1,1
    +|child work

    Record review of what you have read:
      cabaret mark --change child --tip 46080b0eb5bb child.txt
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
  expect((await repo.cabaret("dev", "log", "child")).stdout).toContain(
    `{"kind":"land","merge":"${squash}","tip":"${childTip}"}`,
  );
  // The parent's reviewers skip the squash's diff: it was reviewed in the child.
  expect(await repo.cabaret("review", "--change", "parent", "child.txt")).toEqual({
    stdout: "child.txt in parent\n\nNothing left to review.\n",
    stderr: "",
    exitCode: 0,
  });
  // The landed change still shows its own diff, frozen at the recorded tip.
  expect(await repo.cabaret("review", "--change", "child", "child.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "Review child
    ============

    Reviewing up to 46080b0eb5bb.

      child.txt

    child.txt in child (up to 46080b0eb5bb)

    -1,0 +1,1
    +|child work

    Record review of what you have read:
      cabaret mark --change child --tip 46080b0eb5bb child.txt
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
    stderr: 'config cabaret.landMethod must be one of merge, squash: "rebase"\n',
    exitCode: 1,
  });
  expect(await repo.git("rev-parse", "parent")).toBe(parentTip);
});

test("land requires the parent's own review obligations satisfied", async () => {
  const repo = await makeStack();
  await repo.cabaret("mark", "--tip", "HEAD", "child.txt");
  await repo.git("checkout", "-q", "parent");
  await repo.write("parent.txt", "parent v2\n");
  await repo.git("commit", "-qam", "more parent work");
  // The child is reviewed, but the parent's fresh work awaits its owner.
  expect(await repo.cabaret("land", "child")).toEqual({
    stdout: "",
    stderr:
      'parent "parent" has unsatisfied review obligations; pass --even-though-parent-unreviewed to override:\n' +
      "  parent.txt: 1 more of alice@example.com (owner)\n",
    exitCode: 1,
  });
  expect(await repo.cabaret("land", "child", "--even-though-parent-unreviewed")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
});

test("land into a reviewed parent and onto a trunk parent both pass the parent check", async () => {
  const repo = await makeStack();
  await repo.cabaret("mark", "--tip", "HEAD", "child.txt");
  expect(await repo.cabaret("land")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  // The parent's own parent is main, a trunk with no log: it owes nothing.
  expect(await repo.cabaret("land", "parent")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

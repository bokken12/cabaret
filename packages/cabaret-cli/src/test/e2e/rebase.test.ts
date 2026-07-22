import { expect, test } from "vitest";
import { addChange, makeClone, makeRepo, shownLog, type TestRepo } from "./fixture.js";

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
  expect(await repo.cabaret("review", "--change", "child", "parent.txt")).toEqual({
    stdout: "parent.txt in child\n\nNothing left to review.\n",
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

test("rebase merges the parent's tip in and records the new base", async () => {
  const repo = await makeStack();
  await amendParent(repo);
  const newBase = await repo.git("rev-parse", "parent");
  await repo.git("checkout", "-q", "child");
  expect(await repo.cabaret("rebase")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  // The child keeps its history and gains one merge commit carrying the
  // rewritten parent; its diff against the new base is its own work alone.
  expect(await repo.git("log", "--format=%s", "--first-parent", "child")).toBe(
    "Merge branch 'parent' into child\nchild work\nparent work\nroot",
  );
  expect(await repo.git("rev-parse", "child^2")).toBe(newBase);
  expect(await repo.git("show", "child:parent.txt")).toBe("parent v2");
  expect((await repo.cabaret("dev", "log", "child")).stdout).toContain(`{"kind":"set-base","base":"${newBase}"}`);
  expect(await repo.cabaret("review", "--change", "child", "parent.txt")).toEqual({
    stdout: "parent.txt in child\n\nNothing left to review.\n",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("review", "--change", "child", "child.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "Review child
    ============

    Reviewing up to fb73e7cb3fb0.

      child.txt

    child.txt in child (up to fb73e7cb3fb0)

    -1,0 +1,1
    +|child work

    Record review of what you have read:
      cabaret mark --change child --tip fb73e7cb3fb0 child.txt
    ",
    }
  `);
});

test("a rebase conflict commits the markers and waits for a fix", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "parent");
  await repo.git("checkout", "-q", "parent");
  await repo.write("shared.txt", "from parent\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "parent work");
  const _oldBase = await repo.git("rev-parse", "parent");
  await repo.cabaret("create", "child");
  await repo.git("checkout", "-q", "child");
  await repo.write("shared.txt", "from child\n");
  await repo.git("commit", "-qam", "child work");
  const tipBefore = await repo.git("rev-parse", "child");
  await repo.git("checkout", "-q", "parent");
  await repo.write("shared.txt", "from parent, amended\n");
  await repo.git("commit", "-qa", "--amend", "-m", "parent work, amended");
  const onto = await repo.git("rev-parse", "parent");
  expect(await repo.cabaret("rebase", "child")).toEqual({
    stdout: "",
    stderr: 'merging "parent" into "child" left conflicts in shared.txt; fix the markers and amend\n',
    exitCode: 1,
  });
  // The merge is committed all the same, markers in place and base pinned.
  expect(await repo.git("log", "--format=%s", "--first-parent", "child")).toBe(
    "Merge branch 'parent' into child\nchild work\nparent work\nroot",
  );
  expect(await repo.git("show", "child:shared.txt")).toBe(
    `<<<<<<< ${tipBefore}\nfrom child\n=======\nfrom parent, amended\n>>>>>>> ${onto}`,
  );
  expect(await shownLog(repo, "child")).toMatchInlineSnapshot(`
    "{"timestamp":1748000000005,"user":"alice@example.com","action":{"kind":"set-name","name":"child"}}
    {"timestamp":1748000000006,"user":"alice@example.com","action":{"kind":"set-parent","parent":{"id":"00000000000000000000000000000001"}}}
    {"timestamp":1748000000007,"user":"alice@example.com","action":{"kind":"set-base","base":"aaf2e0dc48428bf54d4b9aae694d45311d1d89ab"}}
    {"timestamp":1748000000008,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}
    {"timestamp":1748000000009,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}
    {"timestamp":1748000000010,"user":"alice@example.com","action":{"kind":"set-base","base":"38504647eb6283c6596aabb6eac12b4273a383dd"}}
    "
  `);
  expect(await repo.cabaret("conflicts", "child")).toEqual({
    stdout: `shared.txt:1: <<<<<<< ${tipBefore}\n`,
    stderr: "",
    exitCode: 0,
  });
  // Until the markers are fixed the change is stuck: no rebase, no land.
  expect(await repo.cabaret("rebase", "child")).toEqual({
    stdout: "",
    stderr: '"child" has unresolved conflicts in shared.txt; fix the markers and amend\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("land", "child")).toEqual({
    stdout: "",
    stderr: '"child" has unresolved conflicts in shared.txt; fix the markers and amend\n',
    exitCode: 1,
  });
  expect((await repo.cabaret("show", "child")).stdout).toContain("fix conflicts");
  // Fixing the markers and amending resolves it; the change lands normally.
  await repo.git("checkout", "-q", "child");
  await repo.write("shared.txt", "from both\n");
  await repo.git("commit", "-qa", "--amend", "-m", "Merge branch 'parent' into child");
  expect(await repo.cabaret("conflicts", "child")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("rebase", "child")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  await repo.cabaret("mark", "--tip", "child", "shared.txt", "--change", "child");
  expect(await repo.cabaret("land", "child", "--even-though-parent-unreviewed")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("show", "parent:shared.txt")).toBe("from both");
});

test("rebase fast-forwards a change with no commits of its own", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "feature");
  await repo.git("checkout", "-q", "main");
  await repo.write("trunk.txt", "trunk work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "trunk work");
  expect(await repo.cabaret("rebase", "feature")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.git("rev-parse", "feature")).toBe(await repo.git("rev-parse", "main"));
  expect(await repo.git("log", "--format=%s", "feature")).toBe("trunk work\nroot");
});

test("a change lands cleanly after a rebase", async () => {
  const repo = await makeRepo();
  await addChange(repo, "feature");
  await repo.git("checkout", "-q", "main");
  await repo.write("trunk.txt", "trunk work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "trunk work");
  expect(await repo.cabaret("rebase", "feature")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  await repo.cabaret("mark", "--tip", "feature", "feature.txt", "--change", "feature");
  expect(await repo.cabaret("land", "feature")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.git("show", "main:feature.txt")).toBe("feature work");
  expect(await repo.git("show", "main:trunk.txt")).toBe("trunk work");
});

test("rebase reads through to origin's copy of a parent that is merely behind", async () => {
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
  // The show page already reads staleness through to origin's copy.
  const shown = (await repo.cabaret("show", "feature")).stdout;
  expect(shown).toContain("(behind parent)");
  // The local branch is just a working position: the rebase stands on the
  // parent's freshest reading, carrying the trunk work in without moving
  // local main.
  const mainBefore = await repo.git("rev-parse", "main");
  expect(await repo.cabaret("rebase", "feature")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.git("show", "feature:trunk.txt")).toBe("trunk work");
  expect(await repo.git("rev-parse", "main")).toBe(mainBefore);
});

test("rebase refuses a diverged parent; overridden, it stands on the local reading", async () => {
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
  await repo.git("fetch", "-q", "origin");
  expect(await repo.cabaret("rebase", "feature")).toEqual({
    stdout: "",
    stderr:
      'local "main" has diverged from origin\'s copy; sync it first, ' +
      "or pass --even-though-parent-diverged to proceed on the local reading\n",
    exitCode: 1,
  });
  expect(await repo.cabaret("rebase", "feature", "--even-though-parent-diverged")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("show", "feature:local.txt")).toBe("local work");
  await expect(repo.git("show", "feature:trunk.txt")).rejects.toThrow();
});

test("a rebase onto a parent the base outran moves nothing", async () => {
  const repo = await makeRepo();
  await addChange(repo, "feature");
  await repo.git("checkout", "-q", "main");
  await repo.write("trunk.txt", "trunk work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "trunk work");
  expect(await repo.cabaret("rebase", "feature")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  // The local main slides back to the root while the base stays pinned ahead
  // of it. Merging that tip would reverse-diff the newer history into the
  // change; the rebase must recognize there is nothing to move.
  await repo.git("checkout", "-q", "feature");
  const root = await repo.git("rev-parse", "main~1");
  await repo.git("update-ref", "refs/heads/main", root);
  const tipBefore = await repo.git("rev-parse", "feature");
  const logBefore = await repo.cabaret("dev", "log", "feature");
  expect(await repo.cabaret("rebase", "feature")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.git("rev-parse", "feature")).toBe(tipBefore);
  expect(await repo.cabaret("dev", "log", "feature")).toEqual(logBefore);
});

test("rebase is a no-op when the change already sits on the parent's tip", async () => {
  const repo = await makeStack();
  const before = await repo.cabaret("dev", "log", "child");
  expect(await repo.cabaret("rebase", "child")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("dev", "log", "child")).toEqual(before);
});

test("rebase pins the base after an out-of-band rebase, surviving a later parent rewrite", async () => {
  const repo = await makeStack();
  await repo.git("checkout", "-q", "parent");
  await repo.write("island.txt", "more parent work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "more parent work");
  await repo.git("checkout", "-q", "child");
  await repo.git("rebase", "-q", "parent");
  const _createdBase = await repo.git("rev-parse", "child~2");
  const _advanced = await repo.git("rev-parse", "parent");
  // The child sits on the parent's tip, so there is nothing to replay; but
  // rebase must still pin the base there, since the merge-base alone would
  // slide back once the parent is rewritten.
  expect(await repo.cabaret("rebase", "child")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await shownLog(repo, "child")).toMatchInlineSnapshot(`
    "{"timestamp":1748000000005,"user":"alice@example.com","action":{"kind":"set-name","name":"child"}}
    {"timestamp":1748000000006,"user":"alice@example.com","action":{"kind":"set-parent","parent":{"id":"00000000000000000000000000000001"}}}
    {"timestamp":1748000000007,"user":"alice@example.com","action":{"kind":"set-base","base":"752ee7d4c0d4880960f49e0ea663059ec0b1c5ec"}}
    {"timestamp":1748000000008,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}
    {"timestamp":1748000000009,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}
    {"timestamp":1748000000010,"user":"alice@example.com","action":{"kind":"set-base","base":"fb9614990d7a450df016bb6152c809b7d82cba4d"}}
    "
  `);
  // Rewrite the parent's tip; without the pinned base the merge-base would
  // fall back and pull the parent's commits into the child's diff.
  await repo.git("checkout", "-q", "parent");
  await repo.write("island.txt", "more parent work, amended\n");
  await repo.git("commit", "-qa", "--amend", "-m", "more parent work, amended");
  expect(await repo.cabaret("review", "--change", "child", "island.txt")).toEqual({
    stdout: "island.txt in child\n\nNothing left to review.\n",
    stderr: "",
    exitCode: 0,
  });
});

test("rebase fails on a change that does not exist", async () => {
  const repo = await makeRepo();
  await repo.git("branch", "orphan");
  expect(await repo.cabaret("rebase", "orphan")).toEqual({
    stdout: "",
    stderr: 'change does not exist: "orphan"; run `cab create`, or `cab fetch` to import open forge changes\n',
    exitCode: 1,
  });
});

test("a range rebases each change onto its parent, ancestormost first", async () => {
  const repo = await makeRepo();
  const _root = await repo.git("rev-parse", "main");
  await addChange(repo, "a");
  const _aOld = await repo.git("rev-parse", "a");
  await addChange(repo, "b");
  const _bOld = await repo.git("rev-parse", "b");
  await addChange(repo, "c");
  await repo.git("checkout", "-q", "main");
  await repo.write("trunk.txt", "trunk work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "trunk work");
  const _mainNew = await repo.git("rev-parse", "main");
  expect(await repo.cabaret("rebase", "main..c")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.git("log", "--format=%s", "--first-parent", "c")).toBe(
    "Merge branch 'b' into c\nc work\nb work\na work\nroot",
  );
  // Each change merged its parent's merged tip, so the trunk's work reaches
  // the top of the stack and nothing of the parent line is left in a diff.
  const [_aNew, bNew] = [await repo.git("rev-parse", "a"), await repo.git("rev-parse", "b")];
  expect(await repo.git("rev-parse", "c^2")).toBe(bNew);
  expect(await repo.git("show", "c:trunk.txt")).toBe("trunk work");
  expect(await repo.cabaret("review", "--change", "c", "b.txt")).toEqual({
    stdout: "b.txt in c\n\nNothing left to review.\n",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("review", "--change", "c", "trunk.txt")).toEqual({
    stdout: "trunk.txt in c\n\nNothing left to review.\n",
    stderr: "",
    exitCode: 0,
  });
  expect(await shownLog(repo, "a")).toMatchInlineSnapshot(`
    "{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-name","name":"a"}}
    {"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}
    {"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-base","base":"1ac0b33426d0417f90ab4eb5ec771b5067e09a9b"}}
    {"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}
    {"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}
    {"timestamp":1748000000005,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"everyone"}}
    {"timestamp":1748000000018,"user":"alice@example.com","action":{"kind":"set-base","base":"5ea531675f501df58bfcc7b0fa4180baf4e20791"}}
    "
  `);
  expect(await shownLog(repo, "b")).toMatchInlineSnapshot(`
    "{"timestamp":1748000000006,"user":"alice@example.com","action":{"kind":"set-name","name":"b"}}
    {"timestamp":1748000000007,"user":"alice@example.com","action":{"kind":"set-parent","parent":{"id":"00000000000000000000000000000001"}}}
    {"timestamp":1748000000008,"user":"alice@example.com","action":{"kind":"set-base","base":"1986c6b9f2d143044aefce5f7ff385d1a493f5c8"}}
    {"timestamp":1748000000009,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}
    {"timestamp":1748000000010,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}
    {"timestamp":1748000000011,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"everyone"}}
    {"timestamp":1748000000019,"user":"alice@example.com","action":{"kind":"set-base","base":"c487be5ad4f41d90666600afefa27b092e939521"}}
    "
  `);
  expect(await shownLog(repo, "c")).toMatchInlineSnapshot(`
    "{"timestamp":1748000000012,"user":"alice@example.com","action":{"kind":"set-name","name":"c"}}
    {"timestamp":1748000000013,"user":"alice@example.com","action":{"kind":"set-parent","parent":{"id":"00000000000000000000000000000002"}}}
    {"timestamp":1748000000014,"user":"alice@example.com","action":{"kind":"set-base","base":"72dd1ac5f70e286ea064d5c9e11468309cd505f5"}}
    {"timestamp":1748000000015,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}
    {"timestamp":1748000000016,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}
    {"timestamp":1748000000017,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"everyone"}}
    {"timestamp":1748000000020,"user":"alice@example.com","action":{"kind":"set-base","base":"457863f7a5da1c56012d5a09dbfaace94bb67a8f"}}
    "
  `);
});

test("a range stops at a conflicted change and a rerun resumes once fixed", async () => {
  const repo = await makeRepo();
  await addChange(repo, "a");
  await addChange(repo, "b");
  await addChange(repo, "c");
  // The trunk claims b.txt too, so merging the trunk's work into b conflicts.
  await repo.git("checkout", "-q", "main");
  await repo.write("b.txt", "trunk version\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "trunk claims b.txt");
  expect(await repo.cabaret("rebase", "main..c")).toEqual({
    stdout: "",
    stderr: 'merging "a" into "b" left conflicts in b.txt; fix the markers and amend\n',
    exitCode: 1,
  });
  // a made it onto the new trunk; b committed the conflict; c never moved.
  expect(await repo.git("log", "--format=%s", "--first-parent", "a")).toBe("Merge branch 'main' into a\na work\nroot");
  expect(await repo.git("log", "--format=%s", "--first-parent", "b")).toBe(
    "Merge branch 'a' into b\nb work\na work\nroot",
  );
  expect(await repo.git("log", "--format=%s", "c")).toBe("c work\nb work\na work\nroot");
  // Rerunning while unresolved stops at b again.
  expect(await repo.cabaret("rebase", "main..c")).toEqual({
    stdout: "",
    stderr: '"b" has unresolved conflicts in b.txt; fix the markers and amend\n',
    exitCode: 1,
  });
  // Fix the markers and amend; the rerun then finishes the chain.
  await repo.git("checkout", "-q", "b");
  await repo.write("b.txt", "b work\n");
  await repo.git("commit", "-qa", "--amend", "-m", "Merge branch 'a' into b");
  expect(await repo.cabaret("rebase", "main..c")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.git("log", "--format=%s", "--first-parent", "c")).toBe(
    "Merge branch 'b' into c\nc work\nb work\na work\nroot",
  );
  expect(await repo.git("show", "c:b.txt")).toBe("b work");
});

test("a range skips a landed change instead of failing", async () => {
  const repo = await makeStack();
  await repo.cabaret("land", "parent");
  const before = await repo.cabaret("dev", "log", "child");
  expect(await repo.cabaret("rebase", "main..child")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("dev", "log", "child")).toEqual(before);
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

test("rebase carries a change checked out in a sibling workspace along", async () => {
  const repo = await makeRepo(undefined, "repo");
  await addChange(repo, "feature");
  // The primary returns to main and advances it; feature moves to a sibling
  // workspace of its own.
  await repo.git("checkout", "-q", "main");
  await repo.write("trunk.txt", "trunk work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "trunk work");
  await repo.cabaret("workspace", "add", "feature");
  expect(await repo.cabaret("rebase", "feature")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  // The sibling workspace followed the rebase: checked out at the new tip
  // with the trunk work present, and nothing stranded in its index.
  expect(await repo.git("-C", "../repo-feature", "rev-parse", "HEAD")).toBe(await repo.git("rev-parse", "feature"));
  expect(await repo.git("-C", "../repo-feature", "status", "--porcelain")).toBe("");
  expect(await repo.git("show", "feature:trunk.txt")).toBe("trunk work");
});

test("a review survives the parent being rewritten and the rebase that follows", async () => {
  const repo = await makeStack();
  await repo.cabaret("mark", "--tip", "HEAD", "child.txt");
  await amendParent(repo);
  // The base is unchanged by the parent's rewrite, so the review still stands.
  expect(await repo.cabaret("review", "--change", "child", "child.txt")).toEqual({
    stdout: "child.txt in child\n\nNothing left to review.\n",
    stderr: "",
    exitCode: 0,
  });
  // The rebase moves the base, but neither base has child.txt, so the
  // reviewed 2-way diff is still sound and the review stands.
  await repo.cabaret("rebase", "child");
  expect(await repo.cabaret("review", "--change", "child", "child.txt")).toEqual({
    stdout: "child.txt in child\n\nNothing left to review.\n",
    stderr: "",
    exitCode: 0,
  });
});

/**
 * A history whose base left the tip's first-parent chain: `feature` edits
 * both.txt and adds feature.txt and plain.txt, child `gadget` lands into it,
 * `mainline` (adding mainline.txt and editing both.txt elsewhere) lands into
 * main, and `feature` then rebases, merging the moved main in. feature.txt
 * and both.txt are marked reviewed before the rebase.
 */
async function makeRebasedFeature(repo: TestRepo): Promise<void> {
  await repo.write("both.txt", "top\nmiddle\nbottom\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "seed both.txt");
  await repo.cabaret("create", "feature");
  await repo.git("checkout", "-q", "feature");
  await repo.write("both.txt", "top (feature)\nmiddle\nbottom\n");
  await repo.write("feature.txt", "feature work\n");
  await repo.write("plain.txt", "plain work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "feature work");
  await repo.cabaret("mark", "--change", "feature", "--tip", "HEAD", "feature.txt", "both.txt");
  await addChange(repo, "gadget");
  await repo.cabaret("land", "gadget", "--even-though-unreviewed", "--even-though-parent-unreviewed");
  await repo.git("checkout", "-q", "main");
  await repo.cabaret("create", "mainline");
  await repo.git("checkout", "-q", "mainline");
  await repo.write("both.txt", "top\nmiddle\nbottom (mainline)\n");
  await repo.write("mainline.txt", "mainline work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "mainline work");
  await repo.cabaret("land", "mainline", "--even-though-unreviewed");
  await repo.git("checkout", "-q", "feature");
  await repo.cabaret("rebase");
}

test("a rebase keeps main's own movement out of review", async () => {
  const repo = await makeRepo();
  await makeRebasedFeature(repo);
  // plain.txt was never reviewed, and its missing review left the landing
  // uncovered, so gadget.txt reads here too. What the rebase merged in
  // (mainline.txt) owes nothing, and the reviews of feature.txt and
  // both.txt carried cleanly through the rebase.
  expect((await repo.cabaret("show", "feature")).stdout).toMatchInlineSnapshot(`
    "feature
    =======

    ╭───────────┬───────────────────╮
    │ attribute │ value             │
    ├───────────┼───────────────────┤
    │ next step │ widen reviewing   │
    │ owner     │ alice@example.com │
    │ reviewing │ none              │
    │ parent    │ main              │
    │ tip       │ 244470f9ef1a      │
    │ base      │ 5e19fa6beaa9      │
    │ workspace │ .                 │
    ╰───────────┴───────────────────╯

    Included changes:
      gadget

    Remaining review:
      alice@example.com: 2 files

    Files to review:
      gadget.txt
      plain.txt
    "
  `);
  for (const settled of ["both.txt", "feature.txt", "mainline.txt"]) {
    expect(await repo.cabaret("review", "--change", "feature", settled)).toEqual({
      stdout: `${settled} in feature\n\nNothing left to review.\n`,
      stderr: "",
      exitCode: 0,
    });
  }
  expect((await repo.cabaret("review", "--change", "feature", "both.txt")).stdout).toMatchInlineSnapshot(`
    "both.txt in feature

    Nothing left to review.
    "
  `);
  expect((await repo.cabaret("review", "--change", "feature", "plain.txt")).stdout).toMatchInlineSnapshot(`
    "Review feature
    ==============

    Reviewing up to 244470f9ef1a.

      plain.txt

    plain.txt in feature (up to 244470f9ef1a)

    -1,0 +1,1
    +|plain work

    Record review of what you have read:
      cabaret mark --change feature --tip 244470f9ef1a plain.txt
    "
  `);
});

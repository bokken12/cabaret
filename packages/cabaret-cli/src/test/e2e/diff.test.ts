import { expect, test } from "vitest";
import { makeRepo, type TestRepo } from "./fixture.js";

/** A repo whose change on `main` (with parent `trunk`) adds `path` with `content`. */
async function makeChange(path: string, content: string): Promise<TestRepo> {
  const repo = await makeRepo();
  await repo.git("branch", "trunk");
  await repo.write(path, content);
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", `add ${path}`);
  await repo.cabaret("create", "main", "--parent", "trunk");
  return repo;
}

test("an unreviewed file diffs from base to tip", async () => {
  const repo = await makeChange("greeting.txt", "hello\n");
  expect(await repo.cabaret("diff", "greeting.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "/dev/null
    new/greeting.txt
    -1,0 +1,1
    +|hello
    ",
    }
  `);
});

test("a reviewed file diffs from the reviewed tip to the current tip", async () => {
  const repo = await makeChange("greeting.txt", "hello\n");
  await repo.cabaret("review", "greeting.txt");
  await repo.write("greeting.txt", "hello\nworld\n");
  await repo.git("commit", "-qam", "expand greeting");
  expect(await repo.cabaret("diff", "greeting.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "old/greeting.txt
    new/greeting.txt
    -1,1 +1,2
      hello
    +|world
    ",
    }
  `);
});

test("a rewritten tip diffs from the reviewed tip's contents", async () => {
  const repo = await makeChange("greeting.txt", "hello\n");
  await repo.cabaret("review", "greeting.txt");
  await repo.write("greeting.txt", "hello\nworld\n");
  await repo.git("commit", "-qa", "--amend", "-m", "add greeting, amended");
  // The reviewed tip left the change's history, but its contents still say
  // what the reviewer knows.
  expect(await repo.cabaret("diff", "greeting.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "old/greeting.txt
    new/greeting.txt
    -1,1 +1,2
      hello
    +|world
    ",
    }
  `);
});

test("a fully reviewed file has an empty diff", async () => {
  const repo = await makeChange("docs/notes.md", "# Notes\n");
  await repo.cabaret("review", "docs/notes.md");
  expect(await repo.cabaret("diff", "docs/notes.md")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("diff --for uses that user's brain, not the caller's", async () => {
  const repo = await makeChange("lib/core.ts", "export const answer = 42;\n");
  await repo.cabaret("review", "lib/core.ts");
  expect(await repo.cabaret("diff", "--for", "bob@example.com", "lib/core.ts")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "/dev/null
    new/lib/core.ts
    -1,0 +1,1
    +|export const answer = 42;
    ",
    }
  `);
});

test("a forgotten file diffs from base to tip again", async () => {
  const repo = await makeChange("greeting.txt", "salut\n");
  await repo.cabaret("review", "greeting.txt");
  await repo.cabaret("forget", "greeting.txt");
  expect(await repo.cabaret("diff", "--change", "main", "greeting.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "/dev/null
    new/greeting.txt
    -1,0 +1,1
    +|salut
    ",
    }
  `);
});

test("diffs a file whose name contains glob characters literally", async () => {
  const repo = await makeChange("app/[slug]/page.tsx", "export default 1;\n");
  expect(await repo.cabaret("diff", "app/[slug]/page.tsx")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "/dev/null
    new/app/[slug]/page.tsx
    -1,0 +1,1
    +|export default 1;
    ",
    }
  `);
});

test("a deleted file diffs to /dev/null", async () => {
  const repo = await makeRepo();
  await repo.write("doomed.txt", "ephemeral\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "add doomed.txt");
  await repo.git("branch", "trunk");
  await repo.git("rm", "-q", "doomed.txt");
  await repo.git("commit", "-qm", "remove doomed.txt");
  await repo.cabaret("create", "main", "--parent", "trunk");
  expect(await repo.cabaret("diff", "doomed.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "old/doomed.txt
    /dev/null
    -1,1 +1,0
    -|ephemeral
    ",
    }
  `);
});

test("binary files are reported, not diffed", async () => {
  const repo = await makeChange("blob.bin", "a\0b\n");
  expect(await repo.cabaret("diff", "blob.bin")).toEqual({
    stdout: "Binary versions of blob.bin differ\n",
    stderr: "",
    exitCode: 0,
  });
});

test("diff fails for a file absent from the whole change", async () => {
  const repo = await makeChange("greeting.txt", "hello\n");
  const base = await repo.git("rev-parse", "trunk");
  const tip = await repo.git("rev-parse", "main");
  expect(await repo.cabaret("diff", "missing.txt")).toEqual({
    stdout: "",
    stderr: `missing.txt exists at none of ${base}, ${tip}\n`,
    exitCode: 1,
  });
});

/**
 * A repo with change `child` stacked on change `parent`: the parent creates
 * `shared.txt` (as `parentShared`) and `parent.txt`, and the child rewrites
 * `shared.txt` to `childShared`. Leaves HEAD on `child`.
 */
async function makeStackWith(parentShared: string, childShared: string): Promise<TestRepo> {
  const repo = await makeRepo();
  await repo.cabaret("create", "parent");
  await repo.git("checkout", "-q", "parent");
  await repo.write("shared.txt", parentShared);
  await repo.write("parent.txt", "parent v1\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "parent work");
  await repo.cabaret("create", "child");
  await repo.git("checkout", "-q", "child");
  await repo.write("shared.txt", childShared);
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "child work");
  return repo;
}

/**
 * The stack over a short shared file: a parent amendment to its first line
 * and a child edit to its last rebase without conflict.
 */
async function makeStack(): Promise<TestRepo> {
  return await makeStackWith(
    "one\ntwo\nthree\nfour\nfive\nsix\nseven\n",
    "one\ntwo\nthree\nfour\nfive\nsix\nseven\nchild\n",
  );
}

/**
 * A shared file long enough that a first-line amendment and an appended line
 * stay in separate diff hunks even at full context.
 */
function longShared(first: string, extra: readonly string[]): string {
  const lines = [first, ...Array.from({ length: 39 }, (_, i) => `line ${i + 2}`), ...extra];
  return `${lines.join("\n")}\n`;
}

/** Amend `parent`'s commit, replacing `file` with `content`, and rebase `child` onto it. */
async function amendParentAndRebase(repo: TestRepo, file: string, content: string): Promise<void> {
  await repo.git("checkout", "-q", "parent");
  await repo.write(file, content);
  await repo.git("commit", "-qa", "--amend", "-m", "parent work, amended");
  await repo.git("checkout", "-q", "child");
  expect(await repo.cabaret("rebase")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
}

test("review survives a rebase that does not touch the file", async () => {
  const repo = await makeStack();
  await repo.cabaret("review", "shared.txt");
  await amendParentAndRebase(repo, "parent.txt", "parent v2\n");
  expect(await repo.cabaret("diff", "shared.txt")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("after a commit and an unrelated rebase, only the commit is left to review", async () => {
  const repo = await makeStack();
  await repo.cabaret("review", "shared.txt");
  await amendParentAndRebase(repo, "parent.txt", "parent v2\n");
  await repo.write("shared.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\nchild\ngrandchild\n");
  await repo.git("commit", "-qam", "more child work");
  expect(await repo.cabaret("diff", "shared.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "old/shared.txt
    new/shared.txt
    -6,3 +6,4
      six
      seven
      child
    +|grandchild
    ",
    }
  `);
});

test("review survives a rebase whose base absorbed the reviewed change", async () => {
  const repo = await makeStack();
  await repo.cabaret("review", "shared.txt");
  // The parent takes the child's copy verbatim, so the rebase drops the
  // child's now-empty commit and the tips coincide.
  await amendParentAndRebase(repo, "shared.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\nchild\n");
  expect(await repo.git("rev-parse", "child")).toBe(await repo.git("rev-parse", "parent"));
  expect(await repo.cabaret("diff", "shared.txt")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("a 4-way diff shows nothing when the rebase carried the change cleanly", async () => {
  const repo = await makeStack();
  await repo.cabaret("review", "shared.txt");
  // The base changed the file underneath the review, but the change merged
  // cleanly around the reviewed edit: both hunks are clean merges.
  await amendParentAndRebase(repo, "shared.txt", "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  expect(await repo.cabaret("diff", "shared.txt")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("after a rebase that changed the file, only the new commit is left to review", async () => {
  const repo = await makeStackWith(longShared("line 1", []), longShared("line 1", ["child"]));
  await repo.cabaret("review", "shared.txt");
  await amendParentAndRebase(repo, "shared.txt", longShared("line 1 amended", []));
  await repo.write("shared.txt", longShared("line 1 amended", ["children"]));
  await repo.git("commit", "-qam", "more child work");
  expect(await repo.cabaret("diff", "shared.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ shared.txt @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
    old base 1e21306344b0 | old tip 655f8d5d9a6e | new base 59b53979aa63 | new tip 901008c1e279
    @@@@@@@@ old tip 38,42 new tip 38,42 @@@@@@@@
      line 38
      line 39
      line 40
    -|child
    +|children
    ",
    }
  `);
});

test("editing the base's change after a rebase shows the new base to new tip diff", async () => {
  const repo = await makeStackWith(longShared("line 1", []), longShared("line 1", ["child"]));
  await repo.cabaret("review", "shared.txt");
  await amendParentAndRebase(repo, "shared.txt", longShared("line 1 amended", []));
  await repo.write("shared.txt", longShared("line 1 rewritten", ["child"]));
  await repo.git("commit", "-qam", "rewrite the amendment");
  expect(await repo.cabaret("diff", "shared.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ shared.txt @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
    old base 1e21306344b0 | old tip 655f8d5d9a6e | new base 59b53979aa63 | new tip aba1eb75681b
    @@@@@@@@ new base 1,5 new tip 1,5 @@@@@@@@
    -|line 1 amended
    +|line 1 rewritten
      line 2
      line 3
      line 4
    ",
    }
  `);
});

test("interacting base and tip changes get the full 4-way views", async () => {
  const repo = await makeStack();
  await repo.cabaret("review", "shared.txt");
  await amendParentAndRebase(repo, "shared.txt", "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  // Rewriting the base's amendment right next to the reviewed edit entangles
  // the two changes into one conflict-class hunk with every view.
  await repo.write("shared.txt", "ONE!\ntwo\nthree\nfour\nfive\nsix\nseven\nchild\n");
  await repo.git("commit", "-qam", "rewrite the amendment");
  expect(await repo.cabaret("diff", "shared.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ shared.txt @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
    old base 34a96a50f88f | old tip 531b9ce6fca4 | new base 7cce234df272 | new tip b328ce393e81
    _
    | @@@@@@@@ View 1/8 : feature-ddiff @@@@@@@@
    | @@@@@@@@ -- old base 1,5 old tip 1,6 @@@@@@@@
    | @@@@@@@@ ++ new base 1,5 new tip 1,6 @@@@@@@@
    | --  one
    | ++-|ONE
    | +++|ONE!
    |     two
    |     three
    |     four
    |_
    _
    | @@@@@@@@ View 2/8 : base-ddiff @@@@@@@@
    | @@@@@@@@ -- old base 1,9 new base 1,10 @@@@@@@@
    | @@@@@@@@ ++ old tip 1,9 new tip 1,10 @@@@@@@@
    |   -|one
    | --+|ONE
    | +++|ONE!
    |     two
    |     three
    |     four
    |     five
    |     six
    |     seven
    | ++  child
    |_
    _
    | @@@@@@@@ View 3/8 : old-tip-to-new-tip @@@@@@@@
    | @@@@@@@@ old tip 1,5 new tip 1,5 @@@@@@@@
    | -|one
    | +|ONE!
    |   two
    |   three
    |   four
    |_
    _
    | @@@@@@@@ View 4/8 : new-base-to-new-tip @@@@@@@@
    | @@@@@@@@ new base 1,8 new tip 1,9 @@@@@@@@
    | -|ONE
    | +|ONE!
    |   two
    |   three
    |   four
    |   five
    |   six
    |   seven
    | +|child
    |_
    _
    | @@@@@@@@ View 5/8 : old-base-to-old-tip @@@@@@@@
    | @@@@@@@@ old base 5,8 old tip 5,9 @@@@@@@@
    |   five
    |   six
    |   seven
    | +|child
    |_
    _
    | @@@@@@@@ View 6/8 : old-base-to-new-base @@@@@@@@
    | @@@@@@@@ old base 1,5 new base 1,5 @@@@@@@@
    | -|one
    | +|ONE
    |   two
    |   three
    |   four
    |_
    _
    | @@@@@@@@ View 7/8 : old-base-to-new-tip @@@@@@@@
    | @@@@@@@@ old base 1,8 new tip 1,9 @@@@@@@@
    | -|one
    | +|ONE!
    |   two
    |   three
    |   four
    |   five
    |   six
    |   seven
    | +|child
    |_
    _
    | @@@@@@@@ View 8/8 : conflict-resolution @@@@@@@@
    | @@@@@@@@ conflict 1,6 new tip 1,5 @@@@@@@@
    | -|<<<<<<< old tip
    | -|one
    | +|ONE!
    |   two
    |   three
    |   four
    | @@@@@@@@ conflict 7,27 new tip 6,9 @@@@@@@@
    |   six
    |   seven
    |   child
    | -|||||||| old base
    | -|one
    | -|two
    | -|three
    | -|four
    | -|five
    | -|six
    | -|seven
    | -|=======
    | -|ONE
    | -|two
    | -|three
    | -|four
    | -|five
    | -|six
    | -|seven
    | -|>>>>>>> new base
    |_
    ",
    }
  `);
});

test("a base that deleted the reviewed file is a dropped base change", async () => {
  const repo = await makeRepo();
  await repo.write("shared.txt", "keep\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "add shared.txt");
  await repo.git("branch", "trunk");
  await repo.git("rm", "-q", "shared.txt");
  await repo.git("commit", "-qm", "delete shared.txt");
  await repo.write("shared.txt", "keep\nchild\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "restore shared.txt with child work");
  await repo.cabaret("create", "main", "--parent", "trunk");
  await repo.cabaret("review", "shared.txt");
  // Advance the base to the deletion commit: the base dropped the file, the
  // feature kept its copy. The absent version diffs as an empty file.
  await repo.git("branch", "-f", "trunk", "main~1");
  expect(await repo.cabaret("diff", "shared.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ shared.txt @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
    old base f4b3ff030cf6 | new base 50884fd79027 | old & new tip 475e44044208
    _
    | @@@@@@@@ View 1/5 : feature-ddiff @@@@@@@@
    | @@@@@@@@ A base change was dropped in favor of a feature change @@@@@@@@
    | @@@@@@@@ -- old base 1,3 tip 1,3 @@@@@@@@
    | @@@@@@@@ ++ new base 1,3 tip 1,3 @@@@@@@@
    | --  keep
    | +++|keep
    |   +|child
    |_
    _
    | @@@@@@@@ View 2/5 : new-base-to-new-tip @@@@@@@@
    | @@@@@@@@ A base change was dropped in favor of a feature change @@@@@@@@
    | @@@@@@@@ The following feature change was kept: @@@@@@@@
    | @@@@@@@@ new base 1,1 tip 1,3 @@@@@@@@
    | +|keep
    | +|child
    |_
    _
    | @@@@@@@@ View 3/5 : story @@@@@@@@
    | _
    | | @@@@@@@@ This base change was dropped... : @@@@@@@@
    | | @@@@@@@@ old base 1,2 new base 1,1 @@@@@@@@
    | | -|keep
    | |_
    | _
    | | @@@@@@@@ ... in favor of this feature change: @@@@@@@@
    | | @@@@@@@@ old base 1,2 tip 1,3 @@@@@@@@
    | |   keep
    | | +|child
    | |_
    |_
    _
    | @@@@@@@@ View 4/5 : base-ddiff @@@@@@@@
    | @@@@@@@@ A base change was dropped in favor of a feature change @@@@@@@@
    | @@@@@@@@ -- old base 1,3 new base 1,1 @@@@@@@@
    | @@@@@@@@ ++ tip 1,3 tip 1,1 @@@@@@@@
    | --@@@@@@@@ old base 1,2 new base 1,1 @@@@@@@@
    | ---|keep
    |_
    _
    | @@@@@@@@ View 5/5 : old-base-to-new-base @@@@@@@@
    | @@@@@@@@ A base change was dropped in favor of a feature change @@@@@@@@
    | @@@@@@@@ The following base change was dropped: @@@@@@@@
    | @@@@@@@@ old base 1,2 new base 1,1 @@@@@@@@
    | -|keep
    |_
    ",
    }
  `);
});

test("an unreviewed file never needs a 4-way diff, even when the base changed it", async () => {
  const repo = await makeStack();
  await amendParentAndRebase(repo, "shared.txt", "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  // The base's copy already holds the amendment, so only the child's own
  // line is left to review.
  expect(await repo.cabaret("diff", "shared.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "old/shared.txt
    new/shared.txt
    -5,3 +5,4
      five
      six
      seven
    +|child
    ",
    }
  `);
});

test("nothing is left to review when the base catches up to the reviewed tip", async () => {
  const repo = await makeChange("greeting.txt", "hello\n");
  await repo.cabaret("review", "greeting.txt");
  await repo.git("branch", "-f", "trunk", "main");
  expect(await repo.cabaret("diff", "greeting.txt")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

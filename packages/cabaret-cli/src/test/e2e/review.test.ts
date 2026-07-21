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

test("a moved file reviews as one entry named by both sides", async () => {
  const repo = await makeRepo();
  await repo.write("notes.txt", "alpha\nbeta\ngamma\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "base");
  await repo.git("branch", "trunk");
  await repo.git("mv", "notes.txt", "journal.txt");
  await repo.git("commit", "-qm", "reorganize");
  await repo.cabaret("create", "main", "--parent", "trunk");
  expect(await repo.cabaret("review")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "Review main
    ===========

    Reviewing up to e20e72be5344.

      notes.txt -> journal.txt

    notes.txt -> journal.txt in main (up to e20e72be5344)

    Moved from notes.txt with no content changes.

    Record review of what you have read:
      cabaret mark --tip e20e72be5344 journal.txt
    ",
    }
  `);
});

test("an exact copy still reviews as an entry, with nothing left to read", async () => {
  const repo = await makeRepo();
  await repo.write("charter.txt", "preamble\narticle one\narticle two\nclosing\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "base");
  await repo.git("branch", "trunk");
  await repo.write("charter.txt", "amended preamble\narticle one\narticle two\nclosing\n");
  await repo.write("bylaws.txt", "preamble\narticle one\narticle two\nclosing\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "duplicate the charter");
  await repo.cabaret("create", "main", "--parent", "trunk");
  expect(await repo.cabaret("review")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "Review main
    ===========

    Reviewing up to 621fe81034fb.

      charter.txt => bylaws.txt
      charter.txt

    charter.txt => bylaws.txt in main (up to 621fe81034fb)

    Copied from charter.txt with no content changes.

    charter.txt in main (up to 621fe81034fb)

    -1,4 +1,4
    -|preamble
    +|amended preamble
      article one
      article two
      closing

    Record review of what you have read:
      cabaret mark --tip 621fe81034fb bylaws.txt charter.txt
    ",
    }
  `);
});

test("review with no arguments shows the whole round", async () => {
  const repo = await makeRepo();
  await repo.git("branch", "trunk");
  await repo.write("greeting.txt", "hello\n");
  await repo.write("src/lib.ts", "export const answer = 42;\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "work");
  await repo.cabaret("create", "main", "--parent", "trunk");
  expect(await repo.cabaret("review")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "Review main
    ===========

    Reviewing up to 39eec8289541.

      greeting.txt
      src/lib.ts

    greeting.txt in main (up to 39eec8289541)

    -1,0 +1,1
    +|hello

    src/lib.ts in main (up to 39eec8289541)

    -1,0 +1,1
    +|export const answer = 42;

    Record review of what you have read:
      cabaret mark --tip 39eec8289541 greeting.txt src/lib.ts
    ",
    }
  `);
});

test("a pattern narrows the round to matching files", async () => {
  const repo = await makeRepo();
  await repo.git("branch", "trunk");
  await repo.write("greeting.txt", "hello\n");
  await repo.write("src/lib.ts", "export const answer = 42;\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "work");
  await repo.cabaret("create", "main", "--parent", "trunk");
  expect(await repo.cabaret("review", "*.ts")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "Review main
    ===========

    Reviewing up to 39eec8289541.

      src/lib.ts

    src/lib.ts in main (up to 39eec8289541)

    -1,0 +1,1
    +|export const answer = 42;

    Record review of what you have read:
      cabaret mark --tip 39eec8289541 src/lib.ts
    ",
    }
  `);
});

test("a pattern matching no file with review left fails", async () => {
  const repo = await makeChange("greeting.txt", "hello\n");
  expect(await repo.cabaret("review", "*.rs")).toEqual({
    stdout: "",
    stderr: 'no file with review left matches "*.rs"\n',
    exitCode: 1,
  });
});

test("an unreviewed file diffs from base to tip", async () => {
  const repo = await makeChange("greeting.txt", "hello\n");
  expect(await repo.cabaret("review", "greeting.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "Review main
    ===========

    Reviewing up to f77053a4cec1.

      greeting.txt

    greeting.txt in main (up to f77053a4cec1)

    -1,0 +1,1
    +|hello

    Record review of what you have read:
      cabaret mark --tip f77053a4cec1 greeting.txt
    ",
    }
  `);
});

test("review from a subdirectory names the file as the log does", async () => {
  const repo = await makeChange("src/greeting.txt", "hello\n");
  expect(await repo.cabaretIn("src", "review", "greeting.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "Review main
    ===========

    Reviewing up to 363aa5e9f4ba.

      src/greeting.txt

    src/greeting.txt in main (up to 363aa5e9f4ba)

    -1,0 +1,1
    +|hello

    Record review of what you have read:
      cabaret mark --tip 363aa5e9f4ba src/greeting.txt
    ",
    }
  `);
});

test("a marked file diffs from the reviewed tip to the current tip", async () => {
  const repo = await makeChange("greeting.txt", "hello\n");
  await repo.cabaret("mark", "--tip", "HEAD", "greeting.txt");
  await repo.write("greeting.txt", "hello\nworld\n");
  await repo.git("commit", "-qam", "expand greeting");
  expect(await repo.cabaret("review", "greeting.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "Review main
    ===========

    Reviewing up to 498dffe67a90.

      greeting.txt

    greeting.txt in main (up to 498dffe67a90)

    -1,1 +1,2
      hello
    +|world

    Record review of what you have read:
      cabaret mark --tip 498dffe67a90 greeting.txt
    ",
    }
  `);
});

test("a rewritten tip diffs from the reviewed tip's contents", async () => {
  const repo = await makeChange("greeting.txt", "hello\n");
  await repo.cabaret("mark", "--tip", "HEAD", "greeting.txt");
  await repo.write("greeting.txt", "hello\nworld\n");
  await repo.git("commit", "-qa", "--amend", "-m", "add greeting, amended");
  // The reviewed tip left the change's history, but its contents still say
  // what the reviewer knows.
  expect(await repo.cabaret("review", "greeting.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "Review main
    ===========

    Reviewing up to f183e9b56a29.

      greeting.txt

    greeting.txt in main (up to f183e9b56a29)

    -1,1 +1,2
      hello
    +|world

    Record review of what you have read:
      cabaret mark --tip f183e9b56a29 greeting.txt
    ",
    }
  `);
});

test("a fully reviewed file has nothing left", async () => {
  const repo = await makeChange("docs/notes.md", "# Notes\n");
  await repo.cabaret("mark", "--tip", "HEAD", "docs/notes.md");
  expect(await repo.cabaret("review", "docs/notes.md")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "docs/notes.md in main

    Nothing left to review.
    ",
    }
  `);
});

test("a forgotten file diffs from base to tip again", async () => {
  const repo = await makeChange("greeting.txt", "salut\n");
  await repo.cabaret("mark", "--tip", "HEAD", "greeting.txt");
  await repo.cabaret("forget", "greeting.txt");
  expect(await repo.cabaret("review", "--change", "main", "greeting.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "Review main
    ===========

    Reviewing up to 562f9d8ba836.

      greeting.txt

    greeting.txt in main (up to 562f9d8ba836)

    -1,0 +1,1
    +|salut

    Record review of what you have read:
      cabaret mark --change main --tip 562f9d8ba836 greeting.txt
    ",
    }
  `);
});

test("shows a file whose name contains glob characters via a pattern", async () => {
  const repo = await makeChange("app/[slug]/page.tsx", "export default 1;\n");
  expect(await repo.cabaret("review", "app/**")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "Review main
    ===========

    Reviewing up to 2ec97028e2a8.

      app/[slug]/page.tsx

    app/[slug]/page.tsx in main (up to 2ec97028e2a8)

    -1,0 +1,1
    +|export default 1;

    Record review of what you have read:
      cabaret mark --tip 2ec97028e2a8 app/[slug]/page.tsx
    ",
    }
  `);
});

test("a deleted file diffs to the empty file", async () => {
  const repo = await makeRepo();
  await repo.write("doomed.txt", "ephemeral\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "add doomed.txt");
  await repo.git("branch", "trunk");
  await repo.git("rm", "-q", "doomed.txt");
  await repo.git("commit", "-qm", "remove doomed.txt");
  await repo.cabaret("create", "main", "--parent", "trunk");
  expect(await repo.cabaret("review", "doomed.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "Review main
    ===========

    Reviewing up to 16f02f8cca5e.

      doomed.txt

    doomed.txt in main (up to 16f02f8cca5e)

    -1,1 +1,0
    -|ephemeral

    Record review of what you have read:
      cabaret mark --tip 16f02f8cca5e doomed.txt
    ",
    }
  `);
});

test("binary files are reported, not diffed", async () => {
  const repo = await makeChange("blob.bin", "a\0b\n");
  expect(await repo.cabaret("review", "blob.bin")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "Review main
    ===========

    Reviewing up to bf82ac59cda0.

      blob.bin

    blob.bin in main (up to bf82ac59cda0)

    Binary versions of blob.bin differ

    Record review of what you have read:
      cabaret mark --tip bf82ac59cda0 blob.bin
    ",
    }
  `);
});

test("a file absent from the whole change has nothing left", async () => {
  const repo = await makeChange("greeting.txt", "hello\n");
  expect(await repo.cabaret("review", "missing.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "missing.txt in main

    Nothing left to review.
    ",
    }
  `);
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
  await repo.cabaret("mark", "--tip", "HEAD", "shared.txt");
  await amendParentAndRebase(repo, "parent.txt", "parent v2\n");
  expect(await repo.cabaret("review", "shared.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "shared.txt in child

    Nothing left to review.
    ",
    }
  `);
});

test("after a commit and an unrelated rebase, only the commit is left to review", async () => {
  const repo = await makeStack();
  await repo.cabaret("mark", "--tip", "HEAD", "shared.txt");
  await amendParentAndRebase(repo, "parent.txt", "parent v2\n");
  await repo.write("shared.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\nchild\ngrandchild\n");
  await repo.git("commit", "-qam", "more child work");
  expect(await repo.cabaret("review", "shared.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "Review child
    ============

    Reviewing up to 60ad97637236.

      shared.txt

    shared.txt in child (up to 60ad97637236)

    -6,3 +6,4
      six
      seven
      child
    +|grandchild

    Record review of what you have read:
      cabaret mark --tip 60ad97637236 shared.txt
    ",
    }
  `);
});

test("review survives a rebase whose base absorbed the reviewed change", async () => {
  const repo = await makeStack();
  await repo.cabaret("mark", "--tip", "HEAD", "shared.txt");
  // The parent takes the child's copy verbatim, so the rebase merge brings
  // nothing of its own and the trees coincide.
  await amendParentAndRebase(repo, "shared.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\nchild\n");
  expect(await repo.git("rev-parse", "child^{tree}")).toBe(await repo.git("rev-parse", "parent^{tree}"));
  expect(await repo.cabaret("review", "shared.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "shared.txt in child

    Nothing left to review.
    ",
    }
  `);
});

test("a 4-way diff shows nothing when the rebase carried the change cleanly", async () => {
  const repo = await makeStack();
  await repo.cabaret("mark", "--tip", "HEAD", "shared.txt");
  // The base changed the file underneath the review, but the change merged
  // cleanly around the reviewed edit: both hunks are clean merges.
  await amendParentAndRebase(repo, "shared.txt", "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  expect(await repo.cabaret("review", "shared.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "shared.txt in child

    Nothing left to review.
    ",
    }
  `);
});

test("after a rebase that changed the file, only the new commit is left to review", async () => {
  const repo = await makeStackWith(longShared("line 1", []), longShared("line 1", ["child"]));
  await repo.cabaret("mark", "--tip", "HEAD", "shared.txt");
  await amendParentAndRebase(repo, "shared.txt", longShared("line 1 amended", []));
  await repo.write("shared.txt", longShared("line 1 amended", ["children"]));
  await repo.git("commit", "-qam", "more child work");
  expect(await repo.cabaret("review", "shared.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "Review child
    ============

    Reviewing up to faa22b2ca864.

      shared.txt

    shared.txt in child (up to faa22b2ca864)

    @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ shared.txt @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
    old base 1e21306344b0 | old tip 655f8d5d9a6e | new base 59b53979aa63 | new tip faa22b2ca864
    @@@@@@@@ old tip 38,42 new tip 38,42 @@@@@@@@
      line 38
      line 39
      line 40
    -|child
    +|children

    Record review of what you have read:
      cabaret mark --tip faa22b2ca864 shared.txt
    ",
    }
  `);
});

test("editing the base's change after a rebase shows the new base to new tip diff", async () => {
  const repo = await makeStackWith(longShared("line 1", []), longShared("line 1", ["child"]));
  await repo.cabaret("mark", "--tip", "HEAD", "shared.txt");
  await amendParentAndRebase(repo, "shared.txt", longShared("line 1 amended", []));
  await repo.write("shared.txt", longShared("line 1 rewritten", ["child"]));
  await repo.git("commit", "-qam", "rewrite the amendment");
  expect(await repo.cabaret("review", "shared.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "Review child
    ============

    Reviewing up to 896995ccb052.

      shared.txt

    shared.txt in child (up to 896995ccb052)

    @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ shared.txt @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
    old base 1e21306344b0 | old tip 655f8d5d9a6e | new base 59b53979aa63 | new tip 896995ccb052
    @@@@@@@@ new base 1,5 new tip 1,5 @@@@@@@@
    -|line 1 amended
    +|line 1 rewritten
      line 2
      line 3
      line 4

    Record review of what you have read:
      cabaret mark --tip 896995ccb052 shared.txt
    ",
    }
  `);
});

test("interacting base and tip changes get the conflict's ddiff", async () => {
  const repo = await makeStack();
  await repo.cabaret("mark", "--tip", "HEAD", "shared.txt");
  await amendParentAndRebase(repo, "shared.txt", "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  // Rewriting the base's amendment right next to the reviewed edit entangles
  // the two changes into one conflict-class hunk.
  await repo.write("shared.txt", "ONE!\ntwo\nthree\nfour\nfive\nsix\nseven\nchild\n");
  await repo.git("commit", "-qam", "rewrite the amendment");
  expect(await repo.cabaret("review", "shared.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "Review child
    ============

    Reviewing up to 2185f0780da5.

      shared.txt

    shared.txt in child (up to 2185f0780da5)

    @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ shared.txt @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
    old base 34a96a50f88f | old tip 531b9ce6fca4 | new base 7cce234df272 | new tip 2185f0780da5
    @@@@@@@@ Conflicting changes: the reviewed diff compared to the current diff @@@@@@@@
    @@@@@@@@ -- old base 1,5 old tip 1,6 @@@@@@@@
    @@@@@@@@ ++ new base 1,5 new tip 1,6 @@@@@@@@
    --  one
    ++-|ONE
    +++|ONE!
        two
        three
        four

    Record review of what you have read:
      cabaret mark --tip 2185f0780da5 shared.txt
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
  await repo.cabaret("mark", "--tip", "HEAD", "shared.txt");
  // Advance the base to the deletion commit: the base dropped the file, the
  // feature kept its copy. The absent version diffs as an empty file.
  await repo.git("branch", "-f", "trunk", "main~1");
  expect(await repo.cabaret("review", "shared.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "Review main
    ===========

    Reviewing up to 475e44044208.

      shared.txt

    shared.txt in main (up to 475e44044208)

    @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@ shared.txt @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
    old base f4b3ff030cf6 | new base 50884fd79027 | old & new tip 475e44044208
    _
    | @@@@@@@@ This base change was dropped... : @@@@@@@@
    | @@@@@@@@ old base 1,2 new base 1,1 @@@@@@@@
    | -|keep
    |_
    _
    | @@@@@@@@ ... in favor of this feature change: @@@@@@@@
    | @@@@@@@@ old base 1,2 tip 1,3 @@@@@@@@
    |   keep
    | +|child
    |_

    Record review of what you have read:
      cabaret mark --tip 475e44044208 shared.txt
    ",
    }
  `);
});

test("an unreviewed file never needs a 4-way diff, even when the base changed it", async () => {
  const repo = await makeStack();
  await amendParentAndRebase(repo, "shared.txt", "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  // The base's copy already holds the amendment, so only the child's own
  // line is left to review.
  expect(await repo.cabaret("review", "shared.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "Review child
    ============

    Reviewing up to 70ca064633a4.

      shared.txt

    shared.txt in child (up to 70ca064633a4)

    -5,3 +5,4
      five
      six
      seven
    +|child

    Record review of what you have read:
      cabaret mark --tip 70ca064633a4 shared.txt
    ",
    }
  `);
});

test("nothing is left to review when the base catches up to the reviewed tip", async () => {
  const repo = await makeChange("greeting.txt", "hello\n");
  await repo.cabaret("mark", "--tip", "HEAD", "greeting.txt");
  await repo.git("branch", "-f", "trunk", "main");
  expect(await repo.cabaret("review", "greeting.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "greeting.txt in main

    Nothing left to review.
    ",
    }
  `);
});

test("git config cabaret.context sets the default hunk context, and --context overrides it", async () => {
  const lines = ["one", "two", "three", "four", "five", "six", "seven"];
  const repo = await makeChange("list.txt", `${lines.join("\n")}\n`);
  await repo.cabaret("mark", "--tip", "HEAD", "list.txt");
  await repo.write("list.txt", `${lines.join("\n").replace("four", "FOUR")}\n`);
  await repo.git("commit", "-qam", "shout four");
  await repo.git("config", "cabaret.context", "1");
  expect((await repo.cabaret("review", "list.txt")).stdout).toMatchInlineSnapshot(`
    "Review main
    ===========

    Reviewing up to 68bb16a23b5e.

      list.txt

    list.txt in main (up to 68bb16a23b5e)

    -3,3 +3,3
      three
    -|four
    +|FOUR
      five

    Record review of what you have read:
      cabaret mark --tip 68bb16a23b5e list.txt
    "
  `);
  expect((await repo.cabaret("review", "list.txt", "--context", "0")).stdout).toMatchInlineSnapshot(`
    "Review main
    ===========

    Reviewing up to 68bb16a23b5e.

      list.txt

    list.txt in main (up to 68bb16a23b5e)

    -4,1 +4,1
    -|four
    +|FOUR

    Record review of what you have read:
      cabaret mark --tip 68bb16a23b5e list.txt
    "
  `);
});

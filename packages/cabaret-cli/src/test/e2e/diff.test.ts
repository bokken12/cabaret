import { expect, test } from "vitest";
import { makeRepo, type TestRepo } from "./fixture.js";

/** A repo whose change on `main` (with parent `trunk`) adds `path` with `content`. */
async function makeChange(path: string, content: string): Promise<TestRepo> {
  const repo = await makeRepo();
  await repo.git("branch", "trunk");
  await repo.write(path, content);
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", `add ${path}`);
  await repo.cabaret("reparent", "main", "trunk");
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
  await repo.cabaret("reparent", "main", "trunk");
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
  const result = await repo.cabaret("diff", "missing.txt");
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("missing.txt exists at neither");
});

/**
 * A repo with change `child` stacked on change `parent`: the parent creates
 * `shared.txt` and `parent.txt`, and the child appends a line to
 * `shared.txt`. The shared file is long enough that a parent amendment to its
 * first line and a child edit to its last rebase without conflict. Leaves
 * HEAD on `child`.
 */
async function makeStack(): Promise<TestRepo> {
  const repo = await makeRepo();
  await repo.cabaret("create", "parent");
  await repo.git("checkout", "-q", "parent");
  await repo.write("shared.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  await repo.write("parent.txt", "parent v1\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "parent work");
  await repo.cabaret("create", "child");
  await repo.git("checkout", "-q", "child");
  await repo.write("shared.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\nchild\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "child work");
  return repo;
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
    -1,8 +1,9
      one
      two
      three
      four
      five
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

test("a rebase that changes the file at its base requires a 4-way diff", async () => {
  const repo = await makeStack();
  await repo.cabaret("review", "shared.txt");
  await amendParentAndRebase(repo, "shared.txt", "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  const result = await repo.cabaret("diff", "shared.txt");
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("4-way diff not yet implemented");
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
    -1,7 +1,8
      ONE
      two
      three
      four
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

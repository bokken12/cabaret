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

test("diff fails when the base moved since the review (4-way diff)", async () => {
  const repo = await makeChange("greeting.txt", "hello\n");
  await repo.cabaret("review", "greeting.txt");
  await repo.git("branch", "-f", "trunk", "main");
  const result = await repo.cabaret("diff", "greeting.txt");
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("4-way diff not yet implemented");
});

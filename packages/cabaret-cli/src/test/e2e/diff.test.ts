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
      "stdout": "diff --git a/greeting.txt b/greeting.txt
    new file mode 100644
    index 0000000..ce01362
    --- /dev/null
    +++ b/greeting.txt
    @@ -0,0 +1 @@
    +hello
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
      "stdout": "diff --git a/greeting.txt b/greeting.txt
    index ce01362..94954ab 100644
    --- a/greeting.txt
    +++ b/greeting.txt
    @@ -1 +1,2 @@
     hello
    +world
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
      "stdout": "diff --git a/lib/core.ts b/lib/core.ts
    new file mode 100644
    index 0000000..64a32fd
    --- /dev/null
    +++ b/lib/core.ts
    @@ -0,0 +1 @@
    +export const answer = 42;
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
      "stdout": "diff --git a/greeting.txt b/greeting.txt
    new file mode 100644
    index 0000000..e601e59
    --- /dev/null
    +++ b/greeting.txt
    @@ -0,0 +1 @@
    +salut
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
      "stdout": "diff --git a/app/[slug]/page.tsx b/app/[slug]/page.tsx
    new file mode 100644
    index 0000000..aef2224
    --- /dev/null
    +++ b/app/[slug]/page.tsx
    @@ -0,0 +1 @@
    +export default 1;
    ",
    }
  `);
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

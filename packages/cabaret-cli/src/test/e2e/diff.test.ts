import { expect, test } from "vitest";
import { makeRepo, type TestRepo } from "./fixture.js";

/** A repo whose change on `main` (with parent `trunk`) adds `files` in one commit. */
async function makeChange(files: Readonly<Record<string, string>>): Promise<TestRepo> {
  const repo = await makeRepo();
  await repo.git("branch", "trunk");
  for (const [path, content] of Object.entries(files)) {
    await repo.write(path, content);
  }
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "work");
  await repo.cabaret("create", "main", "--parent", "trunk");
  return repo;
}

test("diff shows every changed file, base to tip", async () => {
  const repo = await makeChange({ "greeting.txt": "hello\n", "src/lib.ts": "export const answer = 42;\n" });
  expect(await repo.cabaret("diff")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "greeting.txt in main

    -1,0 +1,1
    +|hello

    src/lib.ts in main

    -1,0 +1,1
    +|export const answer = 42;
    ",
    }
  `);
});

test("diff keeps showing the whole change as review is recorded", async () => {
  const repo = await makeChange({ "greeting.txt": "hello\n" });
  const tip = await repo.git("rev-parse", "main");
  await repo.cabaret("mark", "--tip", tip, "greeting.txt");
  expect((await repo.cabaret("diff")).stdout).toMatchInlineSnapshot(`
    "greeting.txt in main

    -1,0 +1,1
    +|hello
    "
  `);
});

test("a pattern narrows the diff to matching files", async () => {
  const repo = await makeChange({ "greeting.txt": "hello\n", "src/lib.ts": "export const answer = 42;\n" });
  expect((await repo.cabaret("diff", "*.ts")).stdout).toMatchInlineSnapshot(`
    "src/lib.ts in main

    -1,0 +1,1
    +|export const answer = 42;
    "
  `);
});

test("a named file outside the change answers with no differences", async () => {
  const repo = await makeRepo();
  await repo.write("untouched.txt", "untouched\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "base file");
  await repo.git("branch", "trunk");
  await repo.write("greeting.txt", "hello\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "work");
  await repo.cabaret("create", "main", "--parent", "trunk");
  expect(await repo.cabaret("diff", "greeting.txt", "untouched.txt")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "greeting.txt in main

    -1,0 +1,1
    +|hello

    untouched.txt in main

    No differences.
    ",
    }
  `);
});

test("a pattern matching no changed file is an error", async () => {
  const repo = await makeChange({ "greeting.txt": "hello\n" });
  expect(await repo.cabaret("diff", "*.rs")).toEqual({
    stdout: "",
    stderr: 'no changed file matches "*.rs"\n',
    exitCode: 1,
  });
});

test("--change diffs a change that is not checked out", async () => {
  const repo = await makeChange({ "greeting.txt": "hello\n" });
  await repo.git("checkout", "-q", "trunk");
  expect((await repo.cabaret("diff", "--change", "main")).stdout).toMatchInlineSnapshot(`
    "greeting.txt in main

    -1,0 +1,1
    +|hello
    "
  `);
});

test("--context widens each hunk", async () => {
  const repo = await makeRepo();
  await repo.write("poem.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "poem");
  await repo.git("branch", "trunk");
  await repo.write("poem.txt", "one\ntwo\nthree\nFOUR\nfive\nsix\nseven\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "shout");
  await repo.cabaret("create", "main", "--parent", "trunk");
  expect((await repo.cabaret("diff", "--context", "1")).stdout).toMatchInlineSnapshot(`
    "poem.txt in main

    -3,3 +3,3
      three
    -|four
    +|FOUR
      five
    "
  `);
});

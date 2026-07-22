import { expect, test } from "vitest";
import { addChange, makeRepo } from "./fixture.js";

test("commit carries its tip to origin, and holds it quietly offline", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await repo.write("gadget.txt", "more gadget work\n");
  expect((await repo.cabaret("commit")).stdout).toBe("");
  // The tip replicated with the commit: origin holds it without a sync.
  expect((await repo.git("ls-remote", "--heads", "origin", "gadget")).split("\t")[0]).toBe(
    await repo.git("rev-parse", "gadget"),
  );
  const origin = await repo.git("remote", "get-url", "origin");
  await repo.git("remote", "set-url", "origin", "ssh://127.0.0.1:1/offline.git");
  await repo.write("gadget.txt", "offline gadget work\n");
  expect((await repo.cabaret("commit")).stdout).toBe("origin unreachable; sync to publish\n");
  await repo.git("remote", "set-url", "origin", origin);
  // The ambient sweep is the retry loop: the next fetch carries the tip.
  expect((await repo.cabaret("fetch")).stdout).toContain('pushed "gadget" to origin');
  expect((await repo.git("ls-remote", "--heads", "origin", "gadget")).split("\t")[0]).toBe(
    await repo.git("rev-parse", "gadget"),
  );
});

test("commit records every edit under the change's name: no message to compose", async () => {
  const repo = await makeRepo();
  await repo.write("kept.txt", "old\n");
  await repo.write("doomed.txt", "doomed\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "setup");
  await repo.write("kept.txt", "new\n");
  await repo.write("fresh.txt", "fresh\n");
  await repo.git("rm", "-q", "doomed.txt");
  expect(await repo.cabaret("commit")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.git("status", "--porcelain")).toBe("");
  expect(await repo.git("show", "--stat", "--format=%s", "HEAD")).toMatchInlineSnapshot(`
    "main

     doomed.txt | 1 -
     fresh.txt  | 1 +
     kept.txt   | 2 +-
     3 files changed, 2 insertions(+), 2 deletions(-)"
  `);
});

test("arguments narrow the commit, leaving other edits in the workspace", async () => {
  const repo = await makeRepo();
  await repo.write("wanted.txt", "wanted\n");
  await repo.write("unwanted.txt", "unwanted\n");
  expect(await repo.cabaret("commit", "wanted.txt")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("show", "--stat", "--format=%s", "HEAD")).toMatchInlineSnapshot(`
    "main

     wanted.txt | 1 +
     1 file changed, 1 insertion(+)"
  `);
  expect(await repo.git("status", "--porcelain")).toBe("?? unwanted.txt");
});

test("a pattern argument commits the files it matches", async () => {
  const repo = await makeRepo();
  await repo.write("src/a.ts", "a\n");
  await repo.write("src/b.ts", "b\n");
  await repo.write("notes.md", "notes\n");
  expect(await repo.cabaret("commit", "src/*.ts")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("status", "--porcelain")).toBe("?? notes.md");
});

test("paths resolve relative to the invoking directory", async () => {
  const repo = await makeRepo();
  await repo.write("src/a.ts", "a\n");
  await repo.write("other.txt", "other\n");
  expect(await repo.cabaretIn("src", "commit", "a.ts")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("status", "--porcelain")).toBe("?? other.txt");
});

test("a clean workspace has nothing to commit", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("commit")).toEqual({
    stdout: "",
    stderr: "nothing to commit\n",
    exitCode: 1,
  });
});

test("a path matching no files is a mistake worth stopping on", async () => {
  const repo = await makeRepo();
  await repo.write("real.txt", "real\n");
  expect(await repo.cabaret("commit", "unreal.txt")).toEqual({
    stdout: "",
    stderr: "pathspec 'unreal.txt' did not match any files\n",
    exitCode: 1,
  });
  expect(await repo.git("status", "--porcelain")).toBe("?? real.txt");
});

test("a detached workspace refuses to commit", async () => {
  const repo = await makeRepo();
  await repo.git("checkout", "-q", "--detach");
  await repo.write("stray.txt", "stray\n");
  expect(await repo.cabaret("commit")).toEqual({
    stdout: "",
    stderr: "HEAD is detached; check out a branch or name the change explicitly\n",
    exitCode: 1,
  });
});

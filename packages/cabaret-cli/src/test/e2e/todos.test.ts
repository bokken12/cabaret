import { expect, test } from "vitest";
import { makeRepo, type TestRepo } from "./fixture.js";

/** A repo whose change `main` (with parent `trunk`) starts from `trunkFiles` and commits `mainFiles`. */
async function makeChange(trunkFiles: Record<string, string>, mainFiles: Record<string, string>): Promise<TestRepo> {
  const repo = await makeRepo();
  for (const [path, content] of Object.entries(trunkFiles)) {
    await repo.write(path, content);
  }
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "trunk work", "--allow-empty");
  await repo.git("branch", "trunk");
  for (const [path, content] of Object.entries(mainFiles)) {
    await repo.write(path, content);
  }
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "main work");
  await repo.cabaret("create", "main", "--parent", "trunk");
  return repo;
}

test("shows the TODOs the change adds, per file and position", async () => {
  const repo = await makeChange(
    {},
    {
      "src/app.ts": "export const app = 1; // TODO: wire up\n",
      "src/lib.ts": "const x = 2;\n/* TODO: extract\n   a helper */\n",
    },
  );
  expect(await repo.cabaret("todos")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "src/app.ts:1:23:
      TODO: wire up

    src/lib.ts:2:1:
      TODO: extract
      a helper
    ",
    }
  `);
});

test("a moved file's pre-existing TODOs do not appear", async () => {
  const repo = await makeRepo();
  await repo.write("src/old.ts", "export const app = 1; // TODO: wire up\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "base");
  await repo.git("branch", "trunk");
  await repo.git("mv", "src/old.ts", "src/new.ts");
  await repo.git("commit", "-qm", "reorganize");
  await repo.cabaret("create", "main", "--parent", "trunk");
  expect(await repo.cabaret("todos")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("a pre-existing TODO does not appear, even when edits move it", async () => {
  const repo = await makeChange(
    { "notes.py": "# TODO: an old debt\nstart()\n" },
    { "notes.py": "prelude()\n# TODO: an old debt\nstart()\nfinish() # TODO: handle errors\n" },
  );
  expect(await repo.cabaret("todos")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "notes.py:4:10:
      TODO: handle errors
    ",
    }
  `);
});

test("a change with no new TODOs prints nothing", async () => {
  const repo = await makeChange({ "a.txt": "// TODO: pre-existing\n" }, { "a.txt": "// TODO: pre-existing\nmore\n" });
  expect(await repo.cabaret("todos")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("inspects the named change from anywhere", async () => {
  const repo = await makeChange({}, { "b.sh": "#!/bin/sh\n# TODO: quote args\n" });
  await repo.git("checkout", "-q", "trunk");
  expect(await repo.cabaret("todos", "main")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "b.sh:2:1:
      TODO: quote args
    ",
    }
  `);
});

test("a TODO spanning line-comment continuations keeps its markers", async () => {
  const repo = await makeChange({}, { "run.sh": "true  # TODO: trap signals\n      # and clean up\n" });
  expect(await repo.cabaret("todos")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "run.sh:1:7:
      TODO: trap signals
            # and clean up
    ",
    }
  `);
});

test("a block-comment TODO renders blank lines and dropped indentation", async () => {
  const repo = await makeChange({}, { "lex.ml": "(* TODO: precompute\n\n   the table *)\n" });
  expect(await repo.cabaret("todos")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "lex.ml:1:1:
      TODO: precompute

      the table
    ",
    }
  `);
});

test("a changed submodule is ignored", async () => {
  const repo = await makeChange({}, { "src/app.ts": "// TODO: unpin the dep\n" });
  // Register a gitlink at the repo's own root commit and amend it into the
  // change; a submodule is not a file, so only the real file's TODO shows.
  const root = await repo.git("rev-list", "--max-parents=0", "HEAD");
  await repo.git("update-index", "--add", "--cacheinfo", `160000,${root},vendor/dep`);
  await repo.git("commit", "-qm", "add submodule", "--amend");
  expect(await repo.cabaret("todos")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "src/app.ts:1:1:
      TODO: unpin the dep
    ",
    }
  `);
});

test("handles file names git would otherwise quote", async () => {
  const repo = await makeChange({}, { 'src/héllo "draft".ts': "// TODO: rename this file\n" });
  expect(await repo.cabaret("todos")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "src/héllo "draft".ts:1:1:
      TODO: rename this file
    ",
    }
  `);
});

test("todos fails on a change that does not exist", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("todos", "phantom")).toEqual({
    stdout: "",
    stderr: 'change does not exist: "phantom"; run `cabaret create`, or `cabaret fetch` to import open forge changes\n',
    exitCode: 1,
  });
});

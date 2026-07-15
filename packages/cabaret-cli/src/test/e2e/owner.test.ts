import { expect, test } from "vitest";
import { makeRepo, type TestRepo } from "./fixture.js";

/** A repo with change `feature` created (and therefore owned) by alice. */
async function makeOwnedChange(): Promise<TestRepo> {
  const repo = await makeRepo();
  await repo.cabaret("create", "feature");
  return repo;
}

test("set-owner replaces the owner", async () => {
  const repo = await makeOwnedChange();
  expect(await repo.cabaret("set-owner", "bob@example.com", "--change", "feature")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("log", "feature")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}
    {"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"1ac0b33426d0417f90ab4eb5ec771b5067e09a9b"}}
    {"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}
    {"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-owner","owner":"bob@example.com"}}
    ",
    }
  `);
});

test("set-owner fails on a change that does not exist", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("set-owner", "bob@example.com")).toEqual({
    stdout: "",
    stderr: 'change does not exist: "main"; run `cabaret create`, or `cabaret pull` to import open forge changes\n',
    exitCode: 1,
  });
});

test("only the owner may transfer ownership", async () => {
  const repo = await makeOwnedChange();
  await repo.git("config", "user.email", "bob@example.com");
  const before = await repo.cabaret("log", "feature");
  expect(await repo.cabaret("set-owner", "bob@example.com", "--change", "feature")).toEqual({
    stdout: "",
    stderr:
      '"feature" is owned by "alice@example.com", not "bob@example.com"; pass --even-though-not-owner to override\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("log", "feature")).toEqual(before);
});

test("--even-though-not-owner lets a non-owner transfer ownership", async () => {
  const repo = await makeOwnedChange();
  await repo.git("config", "user.email", "bob@example.com");
  expect(await repo.cabaret("set-owner", "bob@example.com", "--change", "feature", "--even-though-not-owner")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("log", "feature")).stdout).toContain('{"kind":"set-owner","owner":"bob@example.com"}');
});

test("a change owned by an alias is the user's own to operate", async () => {
  const repo = await makeOwnedChange();
  await repo.git("config", "user.email", "bob@example.com");
  expect(await repo.cabaret("set-owner", "bob@example.com", "--change", "feature")).toEqual({
    stdout: "",
    stderr:
      '"feature" is owned by "alice@example.com", not "bob@example.com"; pass --even-though-not-owner to override\n',
    exitCode: 1,
  });
  await repo.git("config", "--add", "cabaret.alias", "alice@example.com");
  expect(await repo.cabaret("set-owner", "bob@example.com", "--change", "feature")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("log", "feature")).stdout).toContain('{"kind":"set-owner","owner":"bob@example.com"}');
});

test("only the owner may reparent a change", async () => {
  const repo = await makeOwnedChange();
  await repo.git("config", "user.email", "bob@example.com");
  const before = await repo.cabaret("log", "feature");
  expect(await repo.cabaret("reparent", "feature", "main")).toEqual({
    stdout: "",
    stderr:
      '"feature" is owned by "alice@example.com", not "bob@example.com"; pass --even-though-not-owner to override\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("log", "feature")).toEqual(before);
  expect(await repo.cabaret("reparent", "feature", "main", "--even-though-not-owner")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
});

test("only the owner may rebase a change", async () => {
  const repo = await makeOwnedChange();
  await repo.git("config", "user.email", "bob@example.com");
  const before = await repo.cabaret("log", "feature");
  expect(await repo.cabaret("rebase", "feature")).toEqual({
    stdout: "",
    stderr:
      '"feature" is owned by "alice@example.com", not "bob@example.com"; pass --even-though-not-owner to override\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("log", "feature")).toEqual(before);
  expect(await repo.cabaret("rebase", "feature", "--even-though-not-owner")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
});

test("guarded commands fail on a change that does not exist, even with the override", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("reparent", "main", "trunk")).toEqual({
    stdout: "",
    stderr: 'change does not exist: "main"; run `cabaret create`, or `cabaret pull` to import open forge changes\n',
    exitCode: 1,
  });
  // The override excuses not being the owner, not a nonexistent change.
  expect(await repo.cabaret("reparent", "main", "trunk", "--even-though-not-owner")).toEqual({
    stdout: "",
    stderr: 'change does not exist: "main"; run `cabaret create`, or `cabaret pull` to import open forge changes\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("log")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

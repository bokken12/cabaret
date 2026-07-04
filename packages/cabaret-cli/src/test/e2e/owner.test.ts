import { expect, test } from "vitest";
import { makeRepo, type TestRepo } from "./fixture.js";

/** A repo with change `feature` created (and therefore owned) by alice. */
async function makeOwnedChange(): Promise<TestRepo> {
  const repo = await makeRepo();
  await repo.cabaret("create", "feature");
  return repo;
}

test("create records the creator as owner", async () => {
  const repo = await makeOwnedChange();
  expect(await repo.cabaret("owner", "show", "feature")).toEqual({
    stdout: "alice@example.com\n",
    stderr: "",
    exitCode: 0,
  });
});

test("owner show fails on a change with no owner", async () => {
  const repo = await makeRepo();
  const result = await repo.cabaret("owner", "show");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('change has no owner: "main"');
});

test("transfer replaces the owner", async () => {
  const repo = await makeOwnedChange();
  expect(await repo.cabaret("owner", "transfer", "bob@example.com", "--change", "feature")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("owner", "show", "feature")).toEqual({
    stdout: "bob@example.com\n",
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

test("only the owner may transfer ownership", async () => {
  const repo = await makeOwnedChange();
  await repo.git("config", "user.email", "bob@example.com");
  const before = await repo.cabaret("log", "feature");
  const result = await repo.cabaret("owner", "transfer", "bob@example.com", "--change", "feature");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(
    '"feature" is owned by "alice@example.com", not "bob@example.com"; pass --even-though-not-owner to override',
  );
  expect(await repo.cabaret("log", "feature")).toEqual(before);
});

test("--even-though-not-owner lets a non-owner transfer ownership", async () => {
  const repo = await makeOwnedChange();
  await repo.git("config", "user.email", "bob@example.com");
  expect(
    await repo.cabaret("owner", "transfer", "bob@example.com", "--change", "feature", "--even-though-not-owner"),
  ).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("owner", "show", "feature")).toEqual({
    stdout: "bob@example.com\n",
    stderr: "",
    exitCode: 0,
  });
});

test("only the owner may reparent a change", async () => {
  const repo = await makeOwnedChange();
  await repo.git("config", "user.email", "bob@example.com");
  const before = await repo.cabaret("log", "feature");
  const result = await repo.cabaret("reparent", "feature", "main");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('"feature" is owned by "alice@example.com", not "bob@example.com"');
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
  const result = await repo.cabaret("rebase", "feature");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('"feature" is owned by "alice@example.com", not "bob@example.com"');
  expect(await repo.cabaret("log", "feature")).toEqual(before);
  expect(await repo.cabaret("rebase", "feature", "--even-though-not-owner")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
});

test("a change with no owner is malformed: guarded commands fail even with the override", async () => {
  const repo = await makeRepo();
  const denied = await repo.cabaret("reparent", "main", "trunk");
  expect(denied.exitCode).toBe(1);
  expect(denied.stderr).toContain('change has no owner: "main"');
  // The override excuses not being the owner, not a broken log.
  const overridden = await repo.cabaret("reparent", "main", "trunk", "--even-though-not-owner");
  expect(overridden.exitCode).toBe(1);
  expect(overridden.stderr).toContain('change has no owner: "main"');
  expect(await repo.cabaret("log")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

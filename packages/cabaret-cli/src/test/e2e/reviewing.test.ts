import { forgeChangeId, parseRefName } from "cabaret-core";
import { expect, test } from "vitest";
import { FakeForge } from "./fake-forge.js";
import { addChange, makeRepo, type TestRepo } from "./fixture.js";

const PR = forgeChangeId(1);

/** Commit an `.obligations` file at the repo root requiring one of `users` on every `.txt` file. */
async function requirePolicy(repo: TestRepo, ...users: string[]): Promise<void> {
  const policy = { rules: [{ match: "*.txt", require: { atLeast: 1, of: users } }] };
  await repo.write(".obligations", `${JSON.stringify(policy)}\n`);
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "policy");
}

test("reviewing shows the current set and records a new one", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  expect(await repo.cabaret("reviewing")).toEqual({ stdout: "owner\n", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("reviewing", "none")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("reviewing")).toEqual({ stdout: "none\n", stderr: "", exitCode: 0 });
  expect((await repo.cabaret("log")).stdout).toContain('"action":{"kind":"set-reviewing","reviewing":"none"}');
});

test("reviewing rejects a value outside the set", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  const { stderr, exitCode } = await repo.cabaret("reviewing", "somebody");
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain('not a reviewing set: "somebody" (one of none, owner, reviewers, everyone)');
});

test("widen steps to the next level with review to do, skipping levels that ask nothing", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await repo.cabaret("reviewers", "add", "bob@example.com");
  // The owner has review left, so a draft widens to them first.
  await repo.cabaret("reviewing", "none");
  expect(await repo.cabaret("widen")).toEqual({ stdout: "reviewing owner\n", stderr: "", exitCode: 0 });
  // bob still owes the diff, so the next step is the reviewers.
  expect(await repo.cabaret("widen")).toEqual({ stdout: "reviewing reviewers\n", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("widen")).toEqual({ stdout: "reviewing everyone\n", stderr: "", exitCode: 0 });
  expect((await repo.cabaret("widen")).stderr).toBe('everyone is already reviewing "gadget"\n');
});

test("widen from a draft skips an owner who already read the whole diff", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await repo.cabaret("review", "gadget.txt");
  await repo.cabaret("reviewing", "none");
  // Nobody is a reviewer either, so the first level with anything to ask is everyone.
  expect(await repo.cabaret("widen")).toEqual({ stdout: "reviewing everyone\n", stderr: "", exitCode: 0 });
});

test("obligations reach a user's todo only once the reviewing set includes them", async () => {
  const repo = await makeRepo();
  await requirePolicy(repo, "alice@example.com");
  await repo.git("config", "user.email", "bob@example.com");
  await addChange(repo, "feature");
  const aliceTodo = async () => {
    await repo.git("config", "user.email", "alice@example.com");
    const { stdout } = await repo.cabaret("todo");
    await repo.git("config", "user.email", "bob@example.com");
    return stdout;
  };
  // Only bob, the owner, is reviewing; alice's obligation is not yet asked.
  expect(await aliceTodo()).not.toContain("feature");
  // As a reviewer alice is asked as soon as reviewing widens to reviewers.
  await repo.cabaret("reviewers", "add", "alice@example.com");
  await repo.cabaret("reviewing", "reviewers");
  expect(await aliceTodo()).toContain("feature");
  await repo.cabaret("reviewers", "remove", "alice@example.com");
  expect(await aliceTodo()).not.toContain("feature");
  // Widened to everyone, the obligations files alone decide.
  await repo.cabaret("reviewing", "everyone");
  expect(await aliceTodo()).toContain("feature");
});

test("push opens a draft for an unreviewing change and marks it ready when review starts", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("reviewing", "none");
  expect((await repo.cabaret("push")).stdout).toContain("opened github.com/test-org/widgets#1");
  expect((await forge.getChange(PR)).draft).toBe(true);
  // Widening past none is local intent the next push asserts on the forge.
  await repo.cabaret("widen");
  expect((await repo.cabaret("push")).stdout).toContain("marked github.com/test-org/widgets#1 ready for review");
  expect((await forge.getChange(PR)).draft).toBe(false);
  // Settled: pushing again moves nothing.
  expect((await repo.cabaret("push")).stdout).not.toContain("marked");
});

test("a forge-side draft toggle mirrors into the reviewing set on pull", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("push");
  // A teammate converts the forge change to a draft.
  forge.toggleDraft(PR, true);
  expect((await repo.cabaret("pull")).stdout).toContain(
    "github.com/test-org/widgets#1 was marked draft; reviewing none",
  );
  expect(await repo.cabaret("reviewing")).toEqual({ stdout: "none\n", stderr: "", exitCode: 0 });
  // Marked ready again, review opens to everyone: the forge-faithful reading.
  forge.toggleDraft(PR, false);
  expect((await repo.cabaret("pull")).stdout).toContain(
    "github.com/test-org/widgets#1 was marked ready; reviewing everyone",
  );
  expect(await repo.cabaret("reviewing")).toEqual({ stdout: "everyone\n", stderr: "", exitCode: 0 });
});

test("an imported draft starts with nobody reviewing", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await repo.git("checkout", "-qb", "their-feature");
  await repo.write("their.txt", "their work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "their work");
  await repo.git("push", "-q", "origin", "their-feature");
  await repo.git("checkout", "-q", "main");
  await repo.git("branch", "-qD", "their-feature");
  forge.openPr("carol", parseRefName("their-feature"), parseRefName("main"), "Their feature", true);
  await repo.cabaret("pull");
  expect(await repo.cabaret("reviewing", "--change", "their-feature")).toEqual({
    stdout: "none\n",
    stderr: "",
    exitCode: 0,
  });
});

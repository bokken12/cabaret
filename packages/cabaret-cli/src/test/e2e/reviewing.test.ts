import { forgeChangeId, parseBranchName } from "cabaret-core";
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
  await repo.cabaret("reviewing", "set", "none");
  expect(await repo.cabaret("reviewing", "show")).toEqual({ stdout: "none\n", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("reviewing", "set", "owner")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("reviewing", "show")).toEqual({ stdout: "owner\n", stderr: "", exitCode: 0 });
  expect((await repo.cabaret("dev", "log")).stdout).toContain('"action":{"kind":"set-reviewing","reviewing":"owner"}');
});

test("reviewing rejects a value outside the set", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  const { stderr, exitCode } = await repo.cabaret("reviewing", "set", "somebody");
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain('not a reviewing set: "somebody" (one of none, owner, reviewers, everyone)');
});

test("widen steps to the next level with review to do, skipping levels that ask nothing", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await repo.cabaret("reviewing", "set", "none");
  await repo.cabaret("reviewers", "add", "bob@example.com");
  // The owner has review left, so the fresh draft widens to them first.
  expect(await repo.cabaret("widen")).toEqual({ stdout: "reviewing owner\n", stderr: "", exitCode: 0 });
  // bob still owes the diff, so the next step is the reviewers.
  expect(await repo.cabaret("widen")).toEqual({ stdout: "reviewing reviewers\n", stderr: "", exitCode: 0 });
  expect(await repo.cabaret("widen")).toEqual({ stdout: "reviewing everyone\n", stderr: "", exitCode: 0 });
  expect((await repo.cabaret("widen")).stderr).toBe('everyone is already reviewing "gadget"\n');
});

test("widen from a draft skips an owner who already read the whole diff", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await repo.cabaret("reviewing", "set", "none");
  // Self-review of a draft needs no widening: the owner is never nudged.
  await repo.cabaret("mark", "--tip", "HEAD", "gadget.txt");
  // Nobody is a reviewer either, so the first level with anything to ask is everyone.
  expect(await repo.cabaret("widen")).toEqual({ stdout: "reviewing everyone\n", stderr: "", exitCode: 0 });
});

test("obligations reach a user's home only once the reviewing set includes them", async () => {
  const repo = await makeRepo();
  await requirePolicy(repo, "alice@example.com");
  await repo.git("config", "user.email", "bob@example.com");
  await addChange(repo, "feature");
  await repo.cabaret("reviewing", "set", "owner");
  const aliceHome = async () => {
    await repo.git("config", "user.email", "alice@example.com");
    const { stdout } = await repo.cabaret("home");
    await repo.git("config", "user.email", "bob@example.com");
    // The workspaces section lists whatever is checked out, asked or not;
    // this test cares about the obligation-driven sections above it.
    return stdout.split("Workspaces on this device:")[0] as string;
  };
  // Only bob, the owner, is reviewing; alice's obligation is not yet asked.
  expect(await aliceHome()).not.toContain("feature");
  // As a reviewer alice is asked as soon as reviewing widens to reviewers.
  await repo.cabaret("reviewers", "add", "alice@example.com");
  await repo.cabaret("reviewing", "set", "reviewers");
  expect(await aliceHome()).toContain("feature");
  await repo.cabaret("reviewers", "remove", "alice@example.com");
  expect(await aliceHome()).not.toContain("feature");
  // Widened to everyone, the obligations files alone decide.
  await repo.cabaret("reviewing", "set", "everyone");
  expect(await aliceHome()).toContain("feature");
});

test("no forge change opens while reviewing is none; leaving none opens one ready", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("reviewing", "set", "none");
  // The forge change is the change's attention artifact: an unreviewing sync
  // replicates the branch and log but opens nothing.
  expect((await repo.cabaret("sync")).stdout).toBe('synced "gadget" with origin\n');
  await expect(forge.getChange(PR)).rejects.toThrow("no PR 1");
  // Leaving none is the attention act, and its write-through opens the
  // forge change ready — never as a draft.
  expect((await repo.cabaret("widen")).stdout).toContain("opened github.com/test-org/widgets#1");
  expect((await forge.getChange(PR)).draft).toBe(false);
  // Reviewing back to none marks the existing forge change a draft.
  expect((await repo.cabaret("reviewing", "set", "none")).stdout).toContain(
    "marked github.com/test-org/widgets#1 draft",
  );
  expect((await forge.getChange(PR)).draft).toBe(true);
});

test("a forge-side draft toggle mirrors into the reviewing set on fetch", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("reviewing", "set", "everyone");
  await repo.cabaret("sync");
  // A teammate converts the forge change to a draft.
  forge.toggleDraft(PR, true);
  expect((await repo.cabaret("fetch")).stdout).toContain(
    "github.com/test-org/widgets#1 was marked draft; reviewing none",
  );
  expect(await repo.cabaret("reviewing", "show")).toEqual({ stdout: "none\n", stderr: "", exitCode: 0 });
  // Marked ready again, review opens to everyone: the forge-faithful reading.
  forge.toggleDraft(PR, false);
  expect((await repo.cabaret("fetch")).stdout).toContain(
    "github.com/test-org/widgets#1 was marked ready; reviewing everyone",
  );
  expect(await repo.cabaret("reviewing", "show")).toEqual({ stdout: "everyone\n", stderr: "", exitCode: 0 });
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
  forge.openPr("carol", parseBranchName("their-feature"), parseBranchName("main"), "Their feature", true);
  await repo.cabaret("fetch");
  expect(await repo.cabaret("reviewing", "show", "--change", "their-feature")).toEqual({
    stdout: "none\n",
    stderr: "",
    exitCode: 0,
  });
});

test("review ahead of the reviewing set nudges, and the flag overrides", async () => {
  const repo = await makeRepo();
  await repo.git("config", "user.email", "bob@example.com");
  await addChange(repo, "feature");
  await repo.cabaret("reviewing", "set", "none");
  await repo.git("config", "user.email", "alice@example.com");
  // Only bob, the owner, may review his draft; alice recording review jumps the set.
  expect(await repo.cabaret("mark", "--tip", "feature", "feature.txt", "--change", "feature")).toEqual({
    stdout: "",
    stderr: '"feature" is reviewing none, not "alice@example.com"; pass --even-though-not-reviewing to override\n',
    exitCode: 1,
  });
  const forced = await repo.cabaret(
    "mark",
    "--tip",
    "feature",
    "feature.txt",
    "--change",
    "feature",
    "--even-though-not-reviewing",
  );
  expect(forced).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  // The overridden review is a review: it counts toward obligations.
  expect((await repo.cabaret("dev", "log", "feature")).stdout).toContain('"kind":"review","file":"feature.txt"');
});

test("the owner and a landed change are never nudged", async () => {
  const repo = await makeRepo();
  await addChange(repo, "feature");
  // Self-review of the owner's own draft is welcome at any stage.
  expect(await repo.cabaret("mark", "--tip", "HEAD", "feature.txt")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  await repo.cabaret("land");
  // Post-land review is bookkeeping, open as ever — whatever the set was.
  await repo.git("config", "user.email", "bob@example.com");
  expect(await repo.cabaret("mark", "--tip", "feature", "feature.txt", "--change", "feature")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
});

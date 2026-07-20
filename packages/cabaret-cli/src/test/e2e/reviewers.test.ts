import { forgeChangeId, parseBranchName } from "cabaret-core";
import { expect, test } from "vitest";
import { FakeForge } from "./fake-forge.js";
import { addChange, makeRepo, type TestRepo } from "./fixture.js";

const PR = forgeChangeId(1);

/** The reviewers row of a change's show page, or undefined when it has none. */
async function shownReviewers(repo: TestRepo, ...argv: string[]): Promise<string | undefined> {
  const { stdout } = await repo.cabaret("show", ...argv);
  return stdout.split("\n").find((line) => line.startsWith("│ reviewers"));
}

test("reviewers add and remove append entries, latest per user winning", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "feature");
  expect(await repo.cabaret("reviewers", "add", "bob@example.com", "--change", "feature")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  await repo.cabaret("reviewers", "add", "carol@example.com", "--change", "feature");
  await repo.cabaret("reviewers", "remove", "bob@example.com", "--change", "feature");
  expect(await repo.cabaret("dev", "log", "feature")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}
    {"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"1ac0b33426d0417f90ab4eb5ec771b5067e09a9b"}}
    {"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}
    {"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}
    {"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"add-reviewer","reviewer":"bob@example.com"}}
    {"timestamp":1748000000005,"user":"alice@example.com","action":{"kind":"add-reviewer","reviewer":"carol@example.com"}}
    {"timestamp":1748000000006,"user":"alice@example.com","action":{"kind":"remove-reviewer","reviewer":"bob@example.com"}}
    ",
    }
  `);
  expect(await shownReviewers(repo, "feature")).toBe("│ reviewers │ carol@example.com │");
});

test("reviewers add fails on a change that does not exist, and on a landed change", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("reviewers", "add", "bob@example.com")).toEqual({
    stdout: "",
    stderr: 'change does not exist: "main"; run `cab create`, or `cab fetch` to import open forge changes\n',
    exitCode: 1,
  });
  await addChange(repo, "feature");
  await repo.cabaret("mark", "--tip", "HEAD", "feature.txt");
  await repo.cabaret("land");
  const { stderr, exitCode } = await repo.cabaret("reviewers", "add", "bob@example.com", "--change", "feature");
  expect({ stderr: stderr.replace(/merge [0-9a-f]{40}/, "merge <hash>"), exitCode }).toEqual({
    stderr: 'change has landed: "feature" (merge <hash>)\n',
    exitCode: 1,
  });
});

test("a reviewer owes the whole diff: land refuses until they have reviewed", async () => {
  const repo = await makeRepo();
  await addChange(repo, "feature");
  await repo.cabaret("reviewers", "add", "bob@example.com");
  await repo.cabaret("reviewing", "reviewers");
  await repo.cabaret("mark", "--tip", "HEAD", "feature.txt");
  expect(await repo.cabaret("land")).toEqual({
    stdout: "",
    stderr:
      "review obligations are unsatisfied; pass --even-though-unreviewed to override:\n" +
      "  feature.txt: 1 more of bob@example.com (reviewer)\n",
    exitCode: 1,
  });
  // The change lands in bob's home, not just their obligations.
  await repo.git("config", "user.email", "bob@example.com");
  expect((await repo.cabaret("home")).stdout).toContain("│ feature │      1 │");
  await repo.cabaret("mark", "--tip", "HEAD", "feature.txt");
  await repo.git("config", "user.email", "alice@example.com");
  expect(await repo.cabaret("land")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("sync requests local reviewers on the forge and records the observation", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("reviewers", "add", "github:bob");
  expect(await repo.cabaret("sync")).toEqual({
    stdout:
      "opened github.com/test-org/widgets#1\n" +
      "updated 1 reviewer on github.com/test-org/widgets#1\n" +
      'synced "gadget" with github.com/test-org/widgets#1\n',
    stderr: "",
    exitCode: 0,
  });
  expect((await forge.getChange(PR)).reviewers).toEqual(["github:bob"]);
  expect((await repo.cabaret("dev", "log")).stdout).toContain(
    '"source":{"forge":"github.com/test-org/widgets"},"action":{"kind":"add-reviewer","reviewer":"github:bob"}',
  );
  // The request was observed once: syncing again moves nothing.
  expect((await repo.cabaret("sync")).stdout).toBe('synced "gadget" with github.com/test-org/widgets#1\n');
});

test("fetch mirrors forge-side reviewer changes in; a local removal syncs the withdrawal", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("sync");
  // A teammate requests review from carol on the forge.
  forge.requestReviewer(PR, "carol");
  expect((await repo.cabaret("fetch")).stdout).toBe(
    "recorded github:alice as an alias\n" +
      "updated 1 reviewer from github.com/test-org/widgets#1\n" +
      "fetched 0 comments from github.com/test-org/widgets#1\n" +
      "fetched github.com/test-org/widgets: 1 open forge change\n",
  );
  expect(await shownReviewers(repo)).toBe("│ reviewers    │ github:carol                  │");
  // Removing carol locally is intent the next sync carries to the forge.
  await repo.cabaret("reviewers", "remove", "github:carol");
  expect((await repo.cabaret("sync")).stdout).toBe(
    "updated 1 reviewer on github.com/test-org/widgets#1\n" + 'synced "gadget" with github.com/test-org/widgets#1\n',
  );
  expect((await forge.getChange(PR)).reviewers).toEqual([]);
  // Settled: another fetch re-mirrors nothing.
  expect((await repo.cabaret("fetch")).stdout).toBe(
    "fetched 0 comments from github.com/test-org/widgets#1\n" +
      "fetched github.com/test-org/widgets: 1 open forge change\n",
  );
  expect(await shownReviewers(repo)).toBeUndefined();
});

test("sync absorbs a forge-side request it has not fetched, rather than withdrawing it", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("sync");
  forge.requestReviewer(PR, "carol");
  // No fetch in between: the sync itself mirrors carol in as an observation
  // and publishes nothing, since what remains after the mirror is no intent.
  expect((await repo.cabaret("sync")).stdout).toBe(
    "updated 1 reviewer from github.com/test-org/widgets#1\n" + 'synced "gadget" with github.com/test-org/widgets#1\n',
  );
  expect((await forge.getChange(PR)).reviewers).toEqual(["github:carol"]);
  expect(await shownReviewers(repo)).toBe("│ reviewers    │ github:carol                  │");
});

test("a reviewer who has reviewed cannot be withdrawn: the removal mirrors back on the next fetch", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("sync");
  forge.requestReviewer(PR, "carol");
  forge.review(PR, "carol");
  await repo.cabaret("fetch");
  await repo.cabaret("reviewers", "remove", "github:carol");
  // The sync attempts the withdrawal, but the forge cannot unmake the review.
  await repo.cabaret("sync");
  expect((await forge.getChange(PR)).reviewers).toEqual(["github:carol"]);
  expect((await repo.cabaret("fetch")).stdout).toBe(
    "updated 1 reviewer from github.com/test-org/widgets#1\n" +
      "fetched 0 comments from github.com/test-org/widgets#1\n" +
      "fetched github.com/test-org/widgets: 1 open forge change\n",
  );
  expect(await shownReviewers(repo)).toBe("│ reviewers    │ github:carol                  │");
});

test("fetch imports a forge change with its reviewers", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await repo.git("push", "-q", "origin", "main");
  await repo.git("checkout", "-qb", "their-feature");
  await repo.write("theirs.txt", "their work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "their work");
  await repo.git("push", "-q", "origin", "their-feature");
  await repo.git("checkout", "-q", "main");
  await repo.git("branch", "-qD", "their-feature");
  const id = forge.openPr("carol", parseBranchName("their-feature"), parseBranchName("main"), "Their feature");
  forge.requestReviewer(id, "alice");
  await repo.cabaret("fetch");
  expect(await shownReviewers(repo, "their-feature")).toBe("│ reviewers    │ github:alice                  │");
  // Imported wholesale, reviewers included, the change holds no engagement:
  // it is pruned when the forge change closes.
  forge.close(id);
  expect((await repo.cabaret("fetch")).stdout).toContain('removed unreviewed change "their-feature"');
});

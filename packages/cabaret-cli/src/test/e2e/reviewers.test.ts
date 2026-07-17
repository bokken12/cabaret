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
  expect(await repo.cabaret("log", "feature")).toMatchInlineSnapshot(`
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
    stderr: 'change does not exist: "main"; run `cabaret create`, or `cabaret pull` to import open forge changes\n',
    exitCode: 1,
  });
  await addChange(repo, "feature");
  await repo.cabaret("review", "feature.txt");
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
  await repo.cabaret("review", "feature.txt");
  expect(await repo.cabaret("land")).toEqual({
    stdout: "",
    stderr:
      "review obligations are unsatisfied; pass --even-though-unreviewed to override:\n" +
      "  feature.txt: 1 more of bob@example.com (reviewer)\n",
    exitCode: 1,
  });
  // The change lands in bob's todo, not just their obligations.
  await repo.git("config", "user.email", "bob@example.com");
  expect((await repo.cabaret("todo")).stdout).toMatchInlineSnapshot(`
    "Todo
    ====

    Changes to review:
    ╭─────────┬────────╮
    │ change  │ review │
    ├─────────┼────────┤
    │ feature │      1 │
    ╰─────────┴────────╯

    Changes you own:
    ╭────────┬────────┬───────────╮
    │ change │ review │ next step │
    ├────────┼────────┼───────────┤
    ╰────────┴────────┴───────────╯

    Workspaces on this device:
    ╭─────────┬───────────┬──────╮
    │ change  │ workspace │ note │
    ├─────────┼───────────┼──────┤
    │ feature │ .         │      │
    ╰─────────┴───────────┴──────╯
    "
  `);
  await repo.cabaret("review", "feature.txt");
  await repo.git("config", "user.email", "alice@example.com");
  expect(await repo.cabaret("land")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("push requests local reviewers on the forge and records the observation", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("reviewers", "add", "github:bob");
  expect(await repo.cabaret("push")).toEqual({
    stdout:
      "opened github.com/test-org/widgets#1\n" +
      "updated 1 reviewer on github.com/test-org/widgets#1\n" +
      "pushed 0 comments to github.com/test-org/widgets#1\n",
    stderr: "",
    exitCode: 0,
  });
  expect((await forge.getChange(PR)).reviewers).toEqual(["github:bob"]);
  expect((await repo.cabaret("log")).stdout).toContain(
    '"source":{"forge":"github.com/test-org/widgets"},"action":{"kind":"add-reviewer","reviewer":"github:bob"}',
  );
  // The request was observed once: pushing or pulling again moves nothing.
  expect((await repo.cabaret("push")).stdout).toBe("pushed 0 comments to github.com/test-org/widgets#1\n");
  expect((await repo.cabaret("pull", "--change", "gadget")).stdout).toBe(
    "pulled 0 comments from github.com/test-org/widgets#1\n",
  );
});

test("pull mirrors forge-side reviewer changes in; a local removal pushes the withdrawal", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("push");
  // A teammate requests review from carol on the forge.
  forge.requestReviewer(PR, "carol");
  expect((await repo.cabaret("pull")).stdout).toBe(
    "recorded github:alice as an alias\n" +
      "updated 1 reviewer from github.com/test-org/widgets#1\n" +
      "pulled 0 comments from github.com/test-org/widgets#1\n" +
      "synced github.com/test-org/widgets: 1 open forge change\n",
  );
  expect(await shownReviewers(repo)).toBe("│ reviewers    │ github:carol                  │");
  // Removing carol locally is intent the next push carries to the forge.
  await repo.cabaret("reviewers", "remove", "github:carol");
  expect((await repo.cabaret("push")).stdout).toBe(
    "updated 1 reviewer on github.com/test-org/widgets#1\n" + "pushed 0 comments to github.com/test-org/widgets#1\n",
  );
  expect((await forge.getChange(PR)).reviewers).toEqual([]);
  // Settled: another pull re-mirrors nothing.
  expect((await repo.cabaret("pull")).stdout).toBe(
    "pulled 0 comments from github.com/test-org/widgets#1\n" +
      "synced github.com/test-org/widgets: 1 open forge change\n",
  );
  expect(await shownReviewers(repo)).toBeUndefined();
});

test("push absorbs a forge-side request it has not pulled, rather than withdrawing it", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("push");
  forge.requestReviewer(PR, "carol");
  // No pull in between: the push itself mirrors carol in as an observation
  // and pushes nothing, since what remains after the mirror is no intent.
  expect((await repo.cabaret("push")).stdout).toBe("pushed 0 comments to github.com/test-org/widgets#1\n");
  expect((await forge.getChange(PR)).reviewers).toEqual(["github:carol"]);
  expect(await shownReviewers(repo)).toBe("│ reviewers    │ github:carol                  │");
});

test("a reviewer who has reviewed cannot be withdrawn: the removal mirrors back on the next pull", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("push");
  forge.requestReviewer(PR, "carol");
  forge.review(PR, "carol");
  await repo.cabaret("pull");
  await repo.cabaret("reviewers", "remove", "github:carol");
  // The push attempts the withdrawal, but the forge cannot unmake the review.
  await repo.cabaret("push");
  expect((await forge.getChange(PR)).reviewers).toEqual(["github:carol"]);
  expect((await repo.cabaret("pull")).stdout).toBe(
    "updated 1 reviewer from github.com/test-org/widgets#1\n" +
      "pulled 0 comments from github.com/test-org/widgets#1\n" +
      "synced github.com/test-org/widgets: 1 open forge change\n",
  );
  expect(await shownReviewers(repo)).toBe("│ reviewers    │ github:carol                  │");
});

test("pull imports a forge change with its reviewers", async () => {
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
  await repo.cabaret("pull");
  expect(await shownReviewers(repo, "their-feature")).toBe("│ reviewers    │ github:alice                  │");
  // Imported wholesale, reviewers included, the change holds no engagement:
  // it is pruned when the forge change closes.
  forge.close(id);
  expect((await repo.cabaret("pull")).stdout).toContain('removed unreviewed change "their-feature"');
});

import { expect, test } from "vitest";
import { addChange, makeRepo, type TestRepo } from "./fixture.js";

/** Commit an `.obligations` file at `path` on the current branch. */
async function commitPolicy(repo: TestRepo, path: string, policy: object): Promise<void> {
  await repo.write(path, `${JSON.stringify(policy)}\n`);
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "policy");
}

test("land requires the owner's self-review even without obligations files", async () => {
  const repo = await makeRepo();
  await addChange(repo, "feature");
  expect(await repo.cabaret("land")).toEqual({
    stdout: "",
    stderr:
      "review obligations are unsatisfied; pass --even-though-unreviewed to override:\n  feature.txt: 1 more of alice@example.com (owner)\n",
    exitCode: 1,
  });
  await repo.cabaret("mark", "--tip", "HEAD", "feature.txt");
  expect(await repo.cabaret("land")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("--even-though-unreviewed lands with obligations unsatisfied", async () => {
  const repo = await makeRepo();
  await addChange(repo, "feature");
  expect(await repo.cabaret("land", "--even-though-unreviewed")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("land refuses until blocking obligations are satisfied, counting the owner's review", async () => {
  const repo = await makeRepo();
  await commitPolicy(repo, ".obligations", {
    rules: [{ match: "*.txt", kind: "blocking", require: { atLeast: 1, of: ["alice@example.com"] } }],
  });
  await addChange(repo, "feature");
  expect(await repo.cabaret("land")).toEqual({
    stdout: "",
    stderr:
      "review obligations are unsatisfied; pass --even-though-unreviewed to override:\n" +
      "  feature.txt: 1 more of alice@example.com (owner)\n" +
      "  feature.txt: 1 more of alice@example.com (.obligations)\n",
    exitCode: 1,
  });
  await repo.cabaret("mark", "--tip", "HEAD", "feature.txt");
  expect(await repo.cabaret("land")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("a blocking requirement on two users needs both reviews", async () => {
  const repo = await makeRepo();
  await commitPolicy(repo, ".obligations", {
    rules: [
      { match: "*.txt", kind: "blocking", require: { atLeast: 2, of: ["alice@example.com", "bob@example.com"] } },
    ],
  });
  await addChange(repo, "feature");
  // Widened so bob's review below is his turn, not an override.
  await repo.cabaret("reviewing", "set", "everyone");
  await repo.cabaret("mark", "--tip", "HEAD", "feature.txt");
  expect(await repo.cabaret("land")).toEqual({
    stdout: "",
    stderr:
      "review obligations are unsatisfied; pass --even-though-unreviewed to override:\n  feature.txt: 1 more of bob@example.com (.obligations)\n",
    exitCode: 1,
  });
  await repo.git("config", "user.email", "bob@example.com");
  await repo.cabaret("mark", "--tip", "HEAD", "feature.txt");
  await repo.git("config", "user.email", "alice@example.com");
  expect(await repo.cabaret("land")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("a follow rule never gates the land, and stays owed after it", async () => {
  const repo = await makeRepo();
  await commitPolicy(repo, ".obligations", {
    rules: [{ match: "*.txt", require: { atLeast: 1, of: ["bob@example.com"] } }],
  });
  await addChange(repo, "feature");
  await repo.cabaret("reviewing", "set", "everyone");
  await repo.cabaret("mark", "--tip", "HEAD", "feature.txt");
  // bob's follow review is still outstanding, and no override is needed.
  expect(await repo.cabaret("land")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  await repo.git("config", "user.email", "bob@example.com");
  expect((await repo.cabaret("home")).stdout).toMatchInlineSnapshot(`
    "Home
    ====

    Changes to review:
    ╭─────────┬────────╮
    │ change  │ review │
    ├─────────┼────────┤
    │ feature │      1 │
    ╰─────────┴────────╯

    Changes you own:
    ╭────────┬───────────╮
    │ change │ next step │
    ├────────┼───────────┤
    ╰────────┴───────────╯

    Workspaces on this device:
    ╭─────────┬────────╮
    │ change  │ note   │
    ├─────────┼────────┤
    │ feature │ landed │
    ╰─────────┴────────╯
    "
  `);
});

test("weakening an obligations file needs sign-off under the policy it replaces", async () => {
  const repo = await makeRepo();
  await commitPolicy(repo, ".obligations", {
    rules: [{ match: "*.txt", kind: "blocking", require: { atLeast: 1, of: ["bob@example.com"] } }],
  });
  await repo.cabaret("create", "loosen");
  await repo.git("checkout", "-q", "loosen");
  // Widened so bob's review below is his turn, not an override.
  await repo.cabaret("reviewing", "set", "everyone");
  await repo.write(".obligations", `${JSON.stringify({ rules: [] })}\n`);
  await repo.git("commit", "-qam", "drop review requirements");
  // The new policy demands nothing, but the replaced version's requirement
  // still governs the file that replaced it.
  expect(await repo.cabaret("land")).toEqual({
    stdout: "",
    stderr:
      "review obligations are unsatisfied; pass --even-though-unreviewed to override:\n" +
      "  .obligations: 1 more of alice@example.com (owner)\n" +
      "  .obligations: 1 more of bob@example.com (.obligations)\n",
    exitCode: 1,
  });
  await repo.cabaret("mark", "--tip", "HEAD", ".obligations");
  await repo.git("config", "user.email", "bob@example.com");
  await repo.cabaret("mark", "--tip", "HEAD", ".obligations");
  await repo.git("config", "user.email", "alice@example.com");
  expect(await repo.cabaret("land")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("a malformed obligations file blocks landing with a diagnostic", async () => {
  const repo = await makeRepo();
  await addChange(repo, "feature");
  await repo.write(".obligations", '{"rules": [{"match": "*.txt"}]}\n');
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "broken policy");
  const tip = await repo.git("rev-parse", "feature");
  expect(await repo.cabaret("land")).toEqual({
    stdout: "",
    stderr:
      `malformed obligations file ".obligations" at ${tip.slice(0, 12)}\n` +
      "✖ Invalid input: expected object, received undefined\n  → at rules[0].require\n",
    exitCode: 1,
  });
});

test("a malformed obligations file reads as the owner's step to fix, asking nobody", async () => {
  const repo = await makeRepo();
  await addChange(repo, "feature");
  await repo.write(".obligations", "not json\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "broken policy");
  await repo.cabaret("reviewing", "set", "everyone");
  expect((await repo.cabaret("show")).stdout).toMatchInlineSnapshot(`
    "feature
    =======

    ╭───────────┬───────────────────╮
    │ attribute │ value             │
    ├───────────┼───────────────────┤
    │ next step │ fix obligations   │
    │ owner     │ alice@example.com │
    │ reviewing │ everyone          │
    │ parent    │ main              │
    │ tip       │ 6387c555e933      │
    │ base      │ 1ac0b33426d0      │
    │ workspace │ .                 │
    ╰───────────┴───────────────────╯

    Files to review:
      .obligations
      feature.txt
    "
  `);
  expect((await repo.cabaret("home")).stdout).toMatchInlineSnapshot(`
    "Home
    ====

    Changes to review:
    ╭────────┬────────╮
    │ change │ review │
    ├────────┼────────┤
    ╰────────┴────────╯

    Changes you own:
    ╭─────────┬─────────────────╮
    │ change  │ next step       │
    ├─────────┼─────────────────┤
    │ feature │ fix obligations │
    ╰─────────┴─────────────────╯

    Workspaces on this device:
    ╭─────────┬──────╮
    │ change  │ note │
    ├─────────┼──────┤
    │ feature │      │
    ╰─────────┴──────╯
    "
  `);
  // Not the owner's problem to anyone else: bob is asked nothing, and no
  // error reaches his pages.
  await repo.git("config", "user.email", "bob@example.com");
  expect((await repo.cabaret("home")).stdout).toMatchInlineSnapshot(`
    "Home
    ====

    Changes to review:
    ╭────────┬────────╮
    │ change │ review │
    ├────────┼────────┤
    ╰────────┴────────╯

    Changes you own:
    ╭────────┬───────────╮
    │ change │ next step │
    ├────────┼───────────┤
    ╰────────┴───────────╯

    Workspaces on this device:
    ╭─────────┬──────╮
    │ change  │ note │
    ├─────────┼──────┤
    │ feature │      │
    ╰─────────┴──────╯
    "
  `);
});

test("fixing a malformed obligations file needs no sign-off from the unreadable version", async () => {
  const repo = await makeRepo();
  await repo.write(".obligations", "not json\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "broken policy");
  await repo.cabaret("create", "mend");
  await repo.git("checkout", "-q", "mend");
  await repo.write(".obligations", `${JSON.stringify({ rules: [] })}\n`);
  await repo.git("commit", "-qam", "mend policy");
  await repo.cabaret("mark", "--tip", "HEAD", ".obligations");
  expect(await repo.cabaret("land")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

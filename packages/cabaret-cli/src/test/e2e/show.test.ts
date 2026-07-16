import { parseRefName } from "cabaret-core";
import { expect, test } from "vitest";
import { FakeForge } from "./fake-forge.js";
import { addChange, makeRepo, tempDir } from "./fixture.js";

test("show renders the current change's status page", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  const { stdout, stderr, exitCode } = await repo.cabaret("show");
  expect({ stderr, exitCode }).toEqual({ stderr: "", exitCode: 0 });
  expect(stdout).toMatchInlineSnapshot(`
    "gadget
    ======

    ╭───────────┬───────────────────╮
    │ attribute │ value             │
    ├───────────┼───────────────────┤
    │ next step │ widen reviewing   │
    │ owner     │ alice@example.com │
    │ reviewing │ none              │
    │ parent    │ main              │
    │ tip       │ f37230616d25      │
    │ base      │ 1ac0b33426d0      │
    │ workspace │ .                 │
    ╰───────────┴───────────────────╯

    Remaining review:
      alice@example.com: 1 file

    Files to review:
      gadget.txt
    "
  `);
});

test("show renders the comments on a change, oldest first, above the files", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await repo.cabaret("comment", "does this handle empty diffs?");
  await repo.cabaret("comment", "second thoughts:\n\nthe flag name reads oddly");
  expect((await repo.cabaret("show")).stdout).toMatchInlineSnapshot(`
    "gadget
    ======

    ╭───────────┬───────────────────╮
    │ attribute │ value             │
    ├───────────┼───────────────────┤
    │ next step │ widen reviewing   │
    │ owner     │ alice@example.com │
    │ reviewing │ none              │
    │ parent    │ main              │
    │ tip       │ f37230616d25      │
    │ base      │ 1ac0b33426d0      │
    │ workspace │ .                 │
    ╰───────────┴───────────────────╯

    Remaining review:
      alice@example.com: 1 file

    Comments:
      2025-05-23T11:33:20.004Z alice@example.com
        does this handle empty diffs?

      2025-05-23T11:33:20.005Z alice@example.com
        second thoughts:

        the flag name reads oddly

    Files to review:
      gadget.txt
    "
  `);
});

test("show renders a change pull imported like any other", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  // The teammate's branch lives on origin and in a PR, but not locally.
  await repo.git("checkout", "-qb", "their-feature");
  await repo.write("their.txt", "their work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "their work");
  await repo.git("push", "-q", "origin", "their-feature");
  await repo.git("checkout", "-q", "main");
  await repo.git("branch", "-qD", "their-feature");
  const id = forge.openPr("carol", parseRefName("their-feature"), parseRefName("main"), "Their feature");
  forge.comment(id, "carol", "please take a look");
  await repo.cabaret("pull");
  expect((await repo.cabaret("show", "their-feature")).stdout).toMatchInlineSnapshot(`
    "their-feature
    =============

    ╭──────────────┬────────────────────────────────╮
    │ attribute    │ value                          │
    ├──────────────┼────────────────────────────────┤
    │ next step    │ review                         │
    │ owner        │ carol@users.noreply.github.com │
    │ reviewing    │ everyone                       │
    │ parent       │ main                           │
    │ forge change │ github.com/test-org/widgets#1  │
    │ tip          │ 7993514c52a1                   │
    │ base         │ 1ac0b33426d0                   │
    ╰──────────────┴────────────────────────────────╯

    Remaining review:
      carol@users.noreply.github.com: 1 file

    Comments:
      2025-06-15T15:06:40.000Z carol@users.noreply.github.com
        please take a look

    Files to review:
      their.txt
    "
  `);
});

test("show tallies the remaining review per user", async () => {
  const repo = await makeRepo();
  const policy = { rules: [{ match: "*.txt", require: { atLeast: 2, of: ["alice@example.com", "bob@example.com"] } }] };
  await repo.write(".obligations", `${JSON.stringify(policy)}\n`);
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "policy");
  await addChange(repo, "feature");
  await repo.cabaret("reviewing", "owner");
  await repo.cabaret("review", "feature.txt");
  expect((await repo.cabaret("show")).stdout).toMatchInlineSnapshot(`
    "feature
    =======

    ╭───────────┬───────────────────╮
    │ attribute │ value             │
    ├───────────┼───────────────────┤
    │ next step │ add reviewers     │
    │ owner     │ alice@example.com │
    │ reviewing │ owner             │
    │ parent    │ main              │
    │ tip       │ 01cd7b3eb0c9      │
    │ base      │ 7651e9c1eed4      │
    │ workspace │ .                 │
    ╰───────────┴───────────────────╯

    Remaining review:
      bob@example.com: 1 file
    "
  `);
});

test("show by name reflects review progress", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await repo.cabaret("reviewing", "owner");
  await repo.cabaret("review", "gadget.txt");
  const { stdout } = await repo.cabaret("show", "gadget");
  expect(stdout).toMatchInlineSnapshot(`
    "gadget
    ======

    ╭───────────┬───────────────────╮
    │ attribute │ value             │
    ├───────────┼───────────────────┤
    │ next step │ add reviewers     │
    │ owner     │ alice@example.com │
    │ reviewing │ owner             │
    │ parent    │ main              │
    │ tip       │ f37230616d25      │
    │ base      │ 1ac0b33426d0      │
    │ workspace │ .                 │
    ╰───────────┴───────────────────╯
    "
  `);
});

test("show notes a tip behind origin's copy and makes pull the step", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await repo.write("gadget.txt", "gadget work v2\n");
  await repo.git("commit", "-qam", "more gadget work");
  await repo.git("push", "-q", "origin", "gadget");
  await repo.git("reset", "-q", "--hard", "HEAD~1");
  expect((await repo.cabaret("show")).stdout).toMatchInlineSnapshot(`
    "gadget
    ======

    ╭───────────┬──────────────────────────────╮
    │ attribute │ value                        │
    ├───────────┼──────────────────────────────┤
    │ next step │ pull                         │
    │ owner     │ alice@example.com            │
    │ reviewing │ none                         │
    │ parent    │ main                         │
    │ tip       │ f37230616d25 (behind origin) │
    │ base      │ 1ac0b33426d0                 │
    │ workspace │ .                            │
    ╰───────────┴──────────────────────────────╯

    Remaining review:
      alice@example.com: 1 file

    Files to review:
      gadget.txt
    "
  `);
});

test("show notes a stale base on its row while review stays the step", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await repo.cabaret("reviewing", "owner");
  await repo.git("checkout", "-q", "main");
  await repo.write("trunk.txt", "trunk work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "trunk work");
  await repo.git("checkout", "-q", "gadget");
  expect((await repo.cabaret("show")).stdout).toMatchInlineSnapshot(`
    "gadget
    ======

    ╭───────────┬──────────────────────────────╮
    │ attribute │ value                        │
    ├───────────┼──────────────────────────────┤
    │ next step │ review                       │
    │ owner     │ alice@example.com            │
    │ reviewing │ owner                        │
    │ parent    │ main                         │
    │ tip       │ f37230616d25                 │
    │ base      │ 1ac0b33426d0 (behind parent) │
    │ workspace │ .                            │
    ╰───────────┴──────────────────────────────╯

    Remaining review:
      alice@example.com: 1 file

    Files to review:
      gadget.txt
    "
  `);
});

test("show tells a change whose parent has landed to reparent", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await addChange(repo, "gizmo");
  await repo.git("checkout", "-q", "gadget");
  await repo.cabaret("review", "gadget.txt");
  expect(await repo.cabaret("land")).toEqual({
    stdout: 'reparented "gizmo" onto "main"\n',
    stderr: "",
    exitCode: 0,
  });
  // Hang gizmo back under the landed gadget to see the nudge.
  await repo.cabaret("reparent", "gizmo", "gadget");
  expect((await repo.cabaret("show", "gizmo")).stdout).toMatchInlineSnapshot(`
    "gizmo
    =====

    ╭───────────┬───────────────────╮
    │ attribute │ value             │
    ├───────────┼───────────────────┤
    │ next step │ reparent          │
    │ owner     │ alice@example.com │
    │ reviewing │ none              │
    │ parent    │ gadget (landed)   │
    │ tip       │ 03c72c897f10      │
    │ base      │ f37230616d25      │
    ╰───────────┴───────────────────╯

    Remaining review:
      alice@example.com: 1 file

    Files to review:
      gizmo.txt
    "
  `);
});

test("show tells a change whose parent branch is gone to reparent", async () => {
  const repo = await makeRepo();
  await repo.git("branch", "-q", "topic");
  await repo.cabaret("create", "feature", "--parent", "topic");
  await repo.git("checkout", "-q", "feature");
  await repo.write("feature.txt", "feature work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "feature work");
  await repo.git("branch", "-qD", "topic");
  expect((await repo.cabaret("show")).stdout).toMatchInlineSnapshot(`
    "feature
    =======

    ╭───────────┬────────────────────────╮
    │ attribute │ value                  │
    ├───────────┼────────────────────────┤
    │ next step │ reparent               │
    │ owner     │ alice@example.com      │
    │ reviewing │ none                   │
    │ parent    │ topic (does not exist) │
    │ tip       │ db5a7532d33d           │
    │ base      │ 1ac0b33426d0           │
    │ workspace │ .                      │
    ╰───────────┴────────────────────────╯

    Remaining review:
      alice@example.com: 1 file

    Files to review:
      feature.txt
    "
  `);
});

test("show notes a tip diverged from origin's copy and makes resolving it the step", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await repo.git("push", "-q", "origin", "gadget");
  await repo.git("commit", "-q", "--amend", "-m", "gadget work, reworded");
  expect((await repo.cabaret("show")).stdout).toMatchInlineSnapshot(`
    "gadget
    ======

    ╭───────────┬─────────────────────────────────────╮
    │ attribute │ value                               │
    ├───────────┼─────────────────────────────────────┤
    │ next step │ resolve divergence                  │
    │ owner     │ alice@example.com                   │
    │ reviewing │ none                                │
    │ parent    │ main                                │
    │ tip       │ 7eccbe63002f (diverged from origin) │
    │ base      │ 1ac0b33426d0                        │
    │ workspace │ .                                   │
    ╰───────────┴─────────────────────────────────────╯

    Remaining review:
      alice@example.com: 1 file

    Files to review:
      gadget.txt
    "
  `);
});

test("show notes a tip ahead of origin's copy without changing the step", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await repo.cabaret("reviewing", "owner");
  await repo.git("push", "-q", "origin", "gadget");
  await repo.write("gadget.txt", "gadget work v2\n");
  await repo.git("commit", "-qam", "more gadget work");
  expect((await repo.cabaret("show")).stdout).toMatchInlineSnapshot(`
    "gadget
    ======

    ╭───────────┬────────────────────────────────╮
    │ attribute │ value                          │
    ├───────────┼────────────────────────────────┤
    │ next step │ review                         │
    │ owner     │ alice@example.com              │
    │ reviewing │ owner                          │
    │ parent    │ main                           │
    │ tip       │ cd374afd6b0a (ahead of origin) │
    │ base      │ 1ac0b33426d0                   │
    │ workspace │ .                              │
    ╰───────────┴────────────────────────────────╯

    Remaining review:
      alice@example.com: 1 file

    Files to review:
      gadget.txt
    "
  `);
});

test("show makes push the step when the forge lacks the reviewed tip", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("push");
  await repo.cabaret("reviewing", "everyone");
  await repo.write("gadget.txt", "gadget work v2\n");
  await repo.git("commit", "-qam", "more gadget work");
  await repo.cabaret("review", "gadget.txt");
  expect((await repo.cabaret("show")).stdout).toMatchInlineSnapshot(`
    "gadget
    ======

    ╭──────────────┬────────────────────────────────╮
    │ attribute    │ value                          │
    ├──────────────┼────────────────────────────────┤
    │ next step    │ push                           │
    │ owner        │ alice@example.com              │
    │ reviewing    │ everyone                       │
    │ parent       │ main                           │
    │ forge change │ github.com/test-org/widgets#1  │
    │ tip          │ cd374afd6b0a (ahead of origin) │
    │ base         │ 1ac0b33426d0                   │
    │ workspace    │ .                              │
    ╰──────────────┴────────────────────────────────╯
    "
  `);
});

test("show notes the forge change's stale target and makes push the step", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("push");
  await repo.cabaret("reviewing", "everyone");
  await repo.cabaret("review", "gadget.txt");
  await repo.git("branch", "-q", "trunk", "main");
  await repo.cabaret("reparent", "gadget", "trunk");
  expect((await repo.cabaret("show")).stdout).toMatchInlineSnapshot(`
    "gadget
    ======

    ╭──────────────┬──────────────────────────────────────────────────╮
    │ attribute    │ value                                            │
    ├──────────────┼──────────────────────────────────────────────────┤
    │ next step    │ push                                             │
    │ owner        │ alice@example.com                                │
    │ reviewing    │ everyone                                         │
    │ parent       │ trunk                                            │
    │ forge change │ github.com/test-org/widgets#1 (merges into main) │
    │ tip          │ f37230616d25                                     │
    │ base         │ 1ac0b33426d0                                     │
    │ workspace    │ .                                                │
    ╰──────────────┴──────────────────────────────────────────────────╯
    "
  `);
});

test("show reads origin's copy even when the branch tracks another remote", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  // The branch tracks a second remote and diverges from it, but Cabaret pins
  // every remote reading to origin — which has no copy, so no note appears.
  const fork = await tempDir("cabaret-e2e-fork-");
  await repo.git("init", "-q", "--bare", fork);
  await repo.git("remote", "add", "fork", fork);
  await repo.git("push", "-qu", "fork", "gadget");
  await repo.git("commit", "-q", "--amend", "-m", "gadget work, reworded");
  expect((await repo.cabaret("show")).stdout).toMatchInlineSnapshot(`
    "gadget
    ======

    ╭───────────┬───────────────────╮
    │ attribute │ value             │
    ├───────────┼───────────────────┤
    │ next step │ widen reviewing   │
    │ owner     │ alice@example.com │
    │ reviewing │ none              │
    │ parent    │ main              │
    │ tip       │ 7eccbe63002f      │
    │ base      │ 1ac0b33426d0      │
    │ workspace │ .                 │
    ╰───────────┴───────────────────╯

    Remaining review:
      alice@example.com: 1 file

    Files to review:
      gadget.txt
    "
  `);
});

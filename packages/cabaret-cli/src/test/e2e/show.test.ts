import { parseBranchName } from "cabaret-core";
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

test("show renders an imported change like any other", async () => {
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
  const id = forge.openPr("carol", parseBranchName("their-feature"), parseBranchName("main"), "Their feature");
  forge.comment(id, "carol", "please take a look");
  await repo.cabaret("fetch");
  expect((await repo.cabaret("show", "their-feature")).stdout).toMatchInlineSnapshot(`
    "their-feature
    =============

    ╭──────────────┬───────────────────────────────╮
    │ attribute    │ value                         │
    ├──────────────┼───────────────────────────────┤
    │ next step    │ review                        │
    │ owner        │ github:carol                  │
    │ reviewing    │ everyone                      │
    │ parent       │ main                          │
    │ forge change │ github.com/test-org/widgets#1 │
    │ tip          │ 7993514c52a1                  │
    │ base         │ 1ac0b33426d0                  │
    ╰──────────────┴───────────────────────────────╯

    Remaining review:
      github:carol: 1 file

    Comments:
      2025-06-15T15:06:40.000Z github:carol
        please take a look

    Files to review:
      their.txt

    fetched 00:00, 2025-01-01
    "
  `);
});

test("show lists the changes landed into a parent; an unreviewed landing joins its review", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "parent");
  await repo.git("checkout", "-q", "parent");
  await repo.write("parent.txt", "parent work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "parent work");
  await repo.cabaret("create", "child");
  await repo.git("checkout", "-q", "child");
  await repo.write("child.txt", "child work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "child work");
  await repo.cabaret("land", "--even-though-unreviewed", "--even-though-parent-unreviewed");
  expect((await repo.cabaret("show", "parent")).stdout).toMatchInlineSnapshot(`
    "parent
    ======

    ╭───────────┬───────────────────╮
    │ attribute │ value             │
    ├───────────┼───────────────────┤
    │ next step │ widen reviewing   │
    │ owner     │ alice@example.com │
    │ reviewing │ none              │
    │ parent    │ main              │
    │ tip       │ 80ad42d25455      │
    │ base      │ 1ac0b33426d0      │
    ╰───────────┴───────────────────╯

    Included changes:
      child

    Remaining review:
      alice@example.com: 2 files

    Files to review:
      child.txt
      parent.txt
    "
  `);
});

test("show renders a branch with no log from its history alone", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await repo.cabaret("mark", "--tip", "HEAD", "gadget.txt");
  await repo.cabaret("land");
  await repo.git("checkout", "-q", "main");
  const { stdout, stderr, exitCode } = await repo.cabaret("show", "main");
  expect({ stderr, exitCode }).toEqual({ stderr: "", exitCode: 0 });
  expect(stdout).toMatchInlineSnapshot(`
    "main
    ====

    ╭───────────┬──────────────╮
    │ attribute │ value        │
    ├───────────┼──────────────┤
    │ tip       │ df22a5b69709 │
    │ workspace │ .            │
    ╰───────────┴──────────────╯

    Included changes:
      gadget
    "
  `);
});

test("show with no name reads a checked-out trunk once changes acknowledge it", async () => {
  const repo = await makeRepo();
  // Standing on a branch no log speaks for keeps the create nudge...
  await repo.git("checkout", "-qb", "scratch");
  expect((await repo.cabaret("show")).stderr).toBe(
    'change does not exist: "scratch"; run `cab create`, or `cab fetch` to import open forge changes\n',
  );
  // ...but a trunk is acknowledged by its children's parent links.
  await repo.git("checkout", "-q", "main");
  await repo.cabaret("create", "gadget");
  const { stdout, stderr, exitCode } = await repo.cabaret("show");
  expect({ stderr, exitCode }).toEqual({ stderr: "", exitCode: 0 });
  expect(stdout).toMatchInlineSnapshot(`
    "main
    ====

    ╭───────────┬──────────────╮
    │ attribute │ value        │
    ├───────────┼──────────────┤
    │ tip       │ 1ac0b33426d0 │
    │ workspace │ .            │
    ╰───────────┴──────────────╯
    "
  `);
});

test("show names a branch outright even when no log speaks for it", async () => {
  const repo = await makeRepo();
  await repo.git("branch", "-q", "scratch");
  const { stdout, stderr, exitCode } = await repo.cabaret("show", "scratch");
  expect({ stderr, exitCode }).toEqual({ stderr: "", exitCode: 0 });
  expect(stdout).toMatchInlineSnapshot(`
    "scratch
    =======

    ╭───────────┬──────────────╮
    │ attribute │ value        │
    ├───────────┼──────────────┤
    │ tip       │ 1ac0b33426d0 │
    ╰───────────┴──────────────╯
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
  await repo.cabaret("reviewing", "set", "owner");
  await repo.cabaret("mark", "--tip", "HEAD", "feature.txt");
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
  await repo.cabaret("reviewing", "set", "owner");
  await repo.cabaret("mark", "--tip", "HEAD", "gadget.txt");
  const { stdout } = await repo.cabaret("show", "gadget");
  expect(stdout).toMatchInlineSnapshot(`
    "gadget
    ======

    ╭───────────┬───────────────────╮
    │ attribute │ value             │
    ├───────────┼───────────────────┤
    │ next step │ land              │
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

test("show notes a tip behind origin's copy and makes sync the step", async () => {
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
    │ next step │ sync                         │
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
  await repo.cabaret("reviewing", "set", "owner");
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
  await repo.cabaret("mark", "--tip", "HEAD", "gadget.txt");
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

test("show notes a tip diverged from origin's copy and makes sync the step", async () => {
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
    │ next step │ sync                                │
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
  await repo.cabaret("reviewing", "set", "owner");
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

test("show makes sync the step when the forge lacks the reviewed tip", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("sync");
  await repo.cabaret("reviewing", "set", "everyone");
  await repo.write("gadget.txt", "gadget work v2\n");
  await repo.git("commit", "-qam", "more gadget work");
  await repo.cabaret("mark", "--tip", "HEAD", "gadget.txt");
  expect((await repo.cabaret("show")).stdout).toMatchInlineSnapshot(`
    "gadget
    ======

    ╭──────────────┬────────────────────────────────╮
    │ attribute    │ value                          │
    ├──────────────┼────────────────────────────────┤
    │ next step    │ sync                           │
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

test("show notes the forge change's stale target and makes sync the step", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("sync");
  await repo.cabaret("reviewing", "set", "everyone");
  await repo.cabaret("mark", "--tip", "HEAD", "gadget.txt");
  await repo.git("branch", "-q", "trunk", "main");
  await repo.cabaret("reparent", "gadget", "trunk");
  expect((await repo.cabaret("show")).stdout).toMatchInlineSnapshot(`
    "gadget
    ======

    ╭──────────────┬──────────────────────────────────────────────────╮
    │ attribute    │ value                                            │
    ├──────────────┼──────────────────────────────────────────────────┤
    │ next step    │ sync                                             │
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

import { parseRefName } from "cabaret-core";
import { expect, test } from "vitest";
import { FakeForge } from "./fake-forge.js";
import { addChange, makeRepo } from "./fixture.js";

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
    │ next step │ review            │
    │ owner     │ alice@example.com │
    │ parent    │ main              │
    │ tip       │ f37230616d25      │
    │ base      │ 1ac0b33426d0      │
    ╰───────────┴───────────────────╯

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
    │ next step │ review            │
    │ owner     │ alice@example.com │
    │ parent    │ main              │
    │ tip       │ f37230616d25      │
    │ base      │ 1ac0b33426d0      │
    ╰───────────┴───────────────────╯

    Comments:
      2025-05-23T11:33:20.003Z alice@example.com
        does this handle empty diffs?

      2025-05-23T11:33:20.004Z alice@example.com
        second thoughts:

        the flag name reads oddly

    Files to review:
      gadget.txt
    "
  `);
});

test("show for an unimported PR renders the as-if-imported view", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  const id = forge.openPr("carol", parseRefName("their-feature"), parseRefName("main"), "Their feature", [
    "their.txt",
    "docs/notes.md",
  ]);
  forge.comment(id, "carol", "please take a look");
  await repo.cabaret("gh", "pull");
  expect((await repo.cabaret("show", "their-feature")).stdout).toMatchInlineSnapshot(`
    "their-feature
    =============

    ╭──────────────┬────────────────────────────────╮
    │ attribute    │ value                          │
    ├──────────────┼────────────────────────────────┤
    │ next step    │ import                         │
    │ owner        │ carol@users.noreply.github.com │
    │ parent       │ main                           │
    │ forge change │ github.com/test-org/widgets#1  │
    │ title        │ Their feature                  │
    ╰──────────────┴────────────────────────────────╯

    Comments:
      2025-06-15T15:06:40.000Z carol@users.noreply.github.com
        please take a look

    Files to review:
      their.txt
      docs/notes.md
    "
  `);
});

test("show by name reflects review progress", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await repo.cabaret("review", "gadget.txt");
  const { stdout } = await repo.cabaret("show", "gadget");
  expect(stdout).toMatchInlineSnapshot(`
    "gadget
    ======

    ╭───────────┬───────────────────╮
    │ attribute │ value             │
    ├───────────┼───────────────────┤
    │ next step │ land              │
    │ owner     │ alice@example.com │
    │ parent    │ main              │
    │ tip       │ f37230616d25      │
    │ base      │ 1ac0b33426d0      │
    ╰───────────┴───────────────────╯
    "
  `);
});

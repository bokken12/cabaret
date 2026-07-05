import { expect, test } from "vitest";
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

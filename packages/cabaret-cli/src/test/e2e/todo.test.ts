import { expect, test } from "vitest";
import { addChange, makeRepo } from "./fixture.js";

test("todo shows review work and owned changes as a tree", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await addChange(repo, "gizmo");
  const { stdout, stderr, exitCode } = await repo.cabaret("todo");
  expect({ stderr, exitCode }).toEqual({ stderr: "", exitCode: 0 });
  expect(stdout).toMatchInlineSnapshot(`
    "╭────────┬────────╮
    │ change │ review │
    ├────────┼────────┤
    │ gadget │      1 │
    │ gizmo  │      1 │
    ╰────────┴────────╯

    Changes you own:
    ╭──────────┬────────┬───────────╮
    │ change   │ review │ next step │
    ├──────────┼────────┼───────────┤
    │ gadget   │      1 │ review    │
    │ └─ gizmo │      1 │ review    │
    ╰──────────┴────────┴───────────╯
    "
  `);
});

test("todo with no changes has nothing to do", async () => {
  const repo = await makeRepo();
  expect((await repo.cabaret("todo")).stdout).toMatchInlineSnapshot(`
    "Nothing to do.
    "
  `);
});

test("a landed change stays only while children hang from it", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await addChange(repo, "gizmo");
  await repo.cabaret("review", "gadget.txt", "--change", "gadget");
  await repo.cabaret("land", "gadget");
  expect((await repo.cabaret("todo")).stdout).toMatchInlineSnapshot(`
    "╭────────┬────────╮
    │ change │ review │
    ├────────┼────────┤
    │ gizmo  │      1 │
    ╰────────┴────────╯

    Changes you own:
    ╭──────────┬────────┬───────────╮
    │ change   │ review │ next step │
    ├──────────┼────────┼───────────┤
    │ gadget   │        │ landed    │
    │ └─ gizmo │      1 │ review    │
    ╰──────────┴────────┴───────────╯
    "
  `);
});

test("a landed change with no children drops out entirely", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await repo.cabaret("review", "gadget.txt");
  await repo.cabaret("land", "gadget");
  expect((await repo.cabaret("todo")).stdout).toMatchInlineSnapshot(`
    "Nothing to do.
    "
  `);
});

import { parseCommitHash, parseRefName } from "cabaret-core";
import { expect, test } from "vitest";
import { FakeForge } from "./fake-forge.js";
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

test("pull imports an open forge change, and todo lists it as a change to review", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  // A teammate's branch lives on origin and in a forge change, but not locally.
  await repo.git("checkout", "-q", "main");
  await repo.git("checkout", "-qb", "their-feature");
  await repo.write("their.txt", "their work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "their work");
  await repo.git("push", "-q", "origin", "their-feature");
  await repo.git("checkout", "-q", "gadget");
  await repo.git("branch", "-qD", "their-feature");
  forge.openPr("carol", parseRefName("their-feature"), parseRefName("main"), "Their feature");
  await repo.cabaret("pull");
  expect((await repo.cabaret("todo")).stdout).toMatchInlineSnapshot(`
    "╭───────────────┬────────╮
    │ change        │ review │
    ├───────────────┼────────┤
    │ gadget        │      1 │
    │ their-feature │      1 │
    ╰───────────────┴────────╯

    Changes you own:
    ╭────────┬────────┬───────────╮
    │ change │ review │ next step │
    ├────────┼────────┼───────────┤
    │ gadget │      1 │ review    │
    ╰────────┴────────┴───────────╯
    "
  `);
});

test("your own forge change joins the changes you own when identities align", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await repo.git("config", "user.email", "alice@users.noreply.github.com");
  await repo.git("checkout", "-qb", "solo-feature");
  await repo.write("solo.txt", "solo work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "solo work");
  await repo.git("push", "-q", "origin", "solo-feature");
  await repo.git("checkout", "-q", "main");
  forge.openPr("alice", parseRefName("solo-feature"), parseRefName("main"), "Solo feature");
  await repo.cabaret("pull");
  expect((await repo.cabaret("todo")).stdout).toMatchInlineSnapshot(`
    "╭──────────────┬────────╮
    │ change       │ review │
    ├──────────────┼────────┤
    │ solo-feature │      1 │
    ╰──────────────┴────────╯

    Changes you own:
    ╭──────────────┬────────┬───────────╮
    │ change       │ review │ next step │
    ├──────────────┼────────┼───────────┤
    │ solo-feature │      1 │ review    │
    ╰──────────────┴────────┴───────────╯
    "
  `);
});

test("a merged forge change is not imported", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  const id = forge.openPr("carol", parseRefName("their-feature"), parseRefName("main"), "Their feature");
  forge.merge(id, parseCommitHash(await repo.git("rev-parse", "main")));
  await repo.cabaret("pull");
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
    │ └─ gizmo │      1 │ reparent  │
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

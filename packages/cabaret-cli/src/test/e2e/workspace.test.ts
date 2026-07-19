import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { addChange, makeRepo, type TestRepo } from "./fixture.js";

/** The repo's primary working tree as git reports it, symlinks (macOS /tmp) resolved. */
async function rootOf(repo: TestRepo): Promise<string> {
  return repo.git("rev-parse", "--show-toplevel");
}

test("workspace add creates a sibling working tree that dir, list, and todo report", async () => {
  const repo = await makeRepo(undefined, "repo");
  await addChange(repo, "gizmo");
  await repo.git("checkout", "-q", "main");
  const root = await rootOf(repo);

  expect(await repo.cabaret("workspace", "add", "gizmo")).toEqual({
    stdout: `${root}-gizmo\n`,
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("workspace", "dir", "gizmo")).toEqual({
    stdout: `${root}-gizmo\n`,
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("workspace", "list")).stdout).toMatchInlineSnapshot(`
    "Workspaces
    ==========

    ╭───────────────┬────────┬──────╮
    │ workspace     │ change │ note │
    ├───────────────┼────────┼──────┤
    │ .             │ main   │      │
    │ ../repo-gizmo │ gizmo  │      │
    ╰───────────────┴────────┴──────╯
    "
  `);
  expect((await repo.cabaret("todo")).stdout).toMatchInlineSnapshot(`
    "Todo
    ====

    Changes to review:
    ╭────────┬────────╮
    │ change │ review │
    ├────────┼────────┤
    ╰────────┴────────╯

    Changes you own:
    ╭────────┬────────┬─────────────────╮
    │ change │ review │ next step       │
    ├────────┼────────┼─────────────────┤
    │ gizmo  │      1 │ widen reviewing │
    ╰────────┴────────┴─────────────────╯

    Workspaces on this device:
    ╭────────┬───────────────┬──────╮
    │ change │ workspace     │ note │
    ├────────┼───────────────┼──────┤
    │ main   │ .             │      │
    │ gizmo  │ ../repo-gizmo │      │
    ╰────────┴───────────────┴──────╯
    "
  `);
});

test("workspace add refuses a second workspace, a missing change, and a landed one", async () => {
  const repo = await makeRepo(undefined, "repo");
  await addChange(repo, "gizmo");
  await addChange(repo, "relic");
  await repo.git("checkout", "-q", "main");
  const root = await rootOf(repo);

  await repo.cabaret("workspace", "add", "gizmo");
  expect(await repo.cabaret("workspace", "add", "gizmo")).toEqual({
    stdout: "",
    stderr: `change already has a workspace: ${root}-gizmo\n`,
    exitCode: 1,
  });
  expect((await repo.cabaret("workspace", "add", "phantom")).stderr).toContain("change does not exist");
  await repo.cabaret("mark", "--tip", "relic", "--change", "relic", "relic.txt");
  await repo.cabaret("land", "relic");
  expect((await repo.cabaret("workspace", "add", "relic")).stderr).toContain("change has landed");
});

test("workspace remove refuses a dirty workspace until --even-though-dirty, and needs one to remove", async () => {
  const repo = await makeRepo(undefined, "repo");
  await addChange(repo, "gizmo");
  await repo.git("checkout", "-q", "main");
  const root = await rootOf(repo);

  await repo.cabaret("workspace", "add", "gizmo");
  await writeFile(join(`${root}-gizmo`, "junk.txt"), "junk\n");
  expect(await repo.cabaret("workspace", "remove", "gizmo")).toEqual({
    stdout: "",
    stderr: `workspace has uncommitted changes: ${root}-gizmo; pass --even-though-dirty to override\n`,
    exitCode: 1,
  });
  expect(await repo.cabaret("workspace", "remove", "--even-though-dirty", "gizmo")).toEqual({
    stdout: `removed ${root}-gizmo\n`,
    stderr: "",
    exitCode: 0,
  });
  // The branch survives its workspace.
  expect(await repo.git("rev-parse", "--verify", "--quiet", "refs/heads/gizmo")).not.toBe("");
  expect(await repo.cabaret("workspace", "remove", "gizmo")).toEqual({
    stdout: "",
    stderr: 'change has no workspace: "gizmo"\n',
    exitCode: 1,
  });
});

test("a landed change stays in the todo workspaces section until its workspace is removed", async () => {
  const repo = await makeRepo(undefined, "repo");
  await addChange(repo, "gizmo");
  await repo.git("checkout", "-q", "main");
  await repo.cabaret("workspace", "add", "gizmo");
  await repo.cabaret("mark", "--tip", "gizmo", "--change", "gizmo", "gizmo.txt");
  await repo.cabaret("land", "gizmo");

  expect((await repo.cabaret("todo")).stdout).toMatchInlineSnapshot(`
    "Todo
    ====

    Changes to review:
    ╭────────┬────────╮
    │ change │ review │
    ├────────┼────────┤
    ╰────────┴────────╯

    Changes you own:
    ╭────────┬────────┬───────────╮
    │ change │ review │ next step │
    ├────────┼────────┼───────────┤
    ╰────────┴────────┴───────────╯

    Workspaces on this device:
    ╭────────┬───────────────┬────────╮
    │ change │ workspace     │ note   │
    ├────────┼───────────────┼────────┤
    │ main   │ .             │        │
    │ gizmo  │ ../repo-gizmo │ landed │
    ╰────────┴───────────────┴────────╯
    "
  `);
  await repo.cabaret("workspace", "remove", "gizmo");
  expect((await repo.cabaret("todo")).stdout).not.toContain("gizmo");
});

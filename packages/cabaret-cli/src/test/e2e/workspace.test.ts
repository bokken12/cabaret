import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { addChange, makeRepo, type TestRepo } from "./fixture.js";

/** The repo's primary working tree as git reports it, symlinks (macOS /tmp) resolved. */
async function rootOf(repo: TestRepo): Promise<string> {
  return repo.git("rev-parse", "--show-toplevel");
}

test("workspace add creates a sibling working tree that dir, list, and home report", async () => {
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
  expect((await repo.cabaret("home")).stdout).toMatchInlineSnapshot(`
    "Home
    ====

    Changes to review:
    ╭────────┬────────╮
    │ change │ review │
    ├────────┼────────┤
    │ gizmo  │      1 │
    ╰────────┴────────╯

    Changes you own:
    ╭────────┬───────────╮
    │ change │ next step │
    ├────────┼───────────┤
    │ gizmo  │ review    │
    ╰────────┴───────────╯

    Workspaces on this device:
    ╭────────┬──────╮
    │ change │ note │
    ├────────┼──────┤
    │ main   │      │
    │ gizmo  │      │
    ╰────────┴──────╯
    "
  `);
});

test("workspace add refuses a second workspace and a missing change, and takes a landed one", async () => {
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
  await repo.cabaret("land", "relic", "--even-though-parent-unreviewed");
  // A landed change still checks out — to browse the frozen code, or to reopen it.
  expect(await repo.cabaret("workspace", "add", "relic")).toEqual({
    stdout: `${root}-relic\n`,
    stderr: "",
    exitCode: 0,
  });
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

test("a landed change stays in the home workspaces section until its workspace is removed", async () => {
  const repo = await makeRepo(undefined, "repo");
  await addChange(repo, "gizmo");
  await repo.git("checkout", "-q", "main");
  await repo.cabaret("workspace", "add", "gizmo");
  await repo.cabaret("mark", "--tip", "gizmo", "--change", "gizmo", "gizmo.txt");
  await repo.cabaret("land", "gizmo");

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
    ╭────────┬────────╮
    │ change │ note   │
    ├────────┼────────┤
    │ main   │        │
    │ gizmo  │ landed │
    ╰────────┴────────╯
    "
  `);
  await repo.cabaret("workspace", "remove", "gizmo");
  expect((await repo.cabaret("home")).stdout).not.toContain("gizmo");
});

test("workspace reclaim removes landed and archived workspaces, keeping dirty ones", async () => {
  const repo = await makeRepo(undefined, "repo");
  await addChange(repo, "gizmo");
  await repo.git("checkout", "-q", "main");
  await addChange(repo, "relic");
  await repo.git("checkout", "-q", "main");
  await addChange(repo, "gadget");
  await repo.git("checkout", "-q", "main");
  const root = await rootOf(repo);
  await repo.cabaret("workspace", "add", "gizmo");
  await repo.cabaret("workspace", "add", "relic");
  await repo.cabaret("workspace", "add", "gadget");
  await repo.cabaret("mark", "--tip", "gizmo", "--change", "gizmo", "gizmo.txt");
  await repo.cabaret("land", "gizmo");
  await repo.cabaret("archive", "--change", "relic");
  await writeFile(join(`${root}-relic`, "junk.txt"), "junk\n");

  // The landed gizmo's clean workspace goes; the archived relic's stays for
  // its uncommitted junk; the live gadget is not reclaiming's business.
  expect(await repo.cabaret("workspace", "reclaim")).toEqual({
    stdout: `removed ${root}-gizmo\nkept ${root}-relic: dirty\n`,
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("workspace", "list")).stdout).toMatchInlineSnapshot(`
    "Workspaces
    ==========

    ╭────────────────┬────────┬─────────────────────╮
    │ workspace      │ change │ note                │
    ├────────────────┼────────┼─────────────────────┤
    │ .              │ main   │                     │
    │ ../repo-gadget │ gadget │                     │
    │ ../repo-relic  │ relic  │ dirty <1m, archived │
    ╰────────────────┴────────┴─────────────────────╯
    "
  `);

  // --all reclaims the live gadget's clean workspace too — its branch keeps
  // everything the workspace held — while dirtiness still protects relic's,
  // and the primary stays put as ever.
  expect(await repo.cabaret("workspace", "reclaim", "--all")).toEqual({
    stdout: `kept ${root}: primary workspace\nremoved ${root}-gadget\nkept ${root}-relic: dirty\n`,
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("workspace", "list")).stdout).toMatchInlineSnapshot(`
    "Workspaces
    ==========

    ╭───────────────┬────────┬─────────────────────╮
    │ workspace     │ change │ note                │
    ├───────────────┼────────┼─────────────────────┤
    │ .             │ main   │                     │
    │ ../repo-relic │ relic  │ dirty <1m, archived │
    ╰───────────────┴────────┴─────────────────────╯
    "
  `);
});

test("workspace reclaim spares the workspace it runs in and says when there is nothing", async () => {
  const repo = await makeRepo(undefined, "repo");
  await addChange(repo, "gizmo");
  await repo.cabaret("mark", "--tip", "gizmo", "--change", "gizmo", "gizmo.txt");
  await repo.cabaret("land", "gizmo");
  // gizmo landed while checked out in the primary workspace: reclaim can
  // remove neither the primary nor the workspace it runs in.
  expect(await repo.cabaret("workspace", "reclaim")).toEqual({
    stdout: `kept ${await rootOf(repo)}: primary workspace\n`,
    stderr: "",
    exitCode: 0,
  });
  await repo.git("checkout", "-q", "main");
  await repo.git("branch", "-qD", "gizmo");
  expect(await repo.cabaret("workspace", "reclaim")).toEqual({
    stdout: "nothing to reclaim\n",
    stderr: "",
    exitCode: 0,
  });
});

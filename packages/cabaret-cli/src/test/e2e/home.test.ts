import { parseBranchName, parseCommitHash } from "cabaret-core";
import { expect, test } from "vitest";
import { FakeForge } from "./fake-forge.js";
import { addChange, makeClone, makeRepo, type TestRepo } from "./fixture.js";

/** Commit an `.obligations` file at the repo root requiring one of `users` on every `.txt` file. */
async function requireReviewers(repo: TestRepo, ...users: string[]): Promise<void> {
  const policy = { rules: [{ match: "*.txt", require: { atLeast: 1, of: users } }] };
  await repo.write(".obligations", `${JSON.stringify(policy)}\n`);
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "policy");
}

test("home shows review work and owned changes as a tree", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await repo.cabaret("reviewing", "set", "owner");
  await addChange(repo, "gizmo");
  await repo.cabaret("reviewing", "set", "owner");
  const { stdout, stderr, exitCode } = await repo.cabaret("home");
  expect({ stderr, exitCode }).toEqual({ stderr: "", exitCode: 0 });
  expect(stdout).toMatchInlineSnapshot(`
    "Home
    ====

    Changes to review:
    ╭──────────┬────────╮
    │ change   │ review │
    ├──────────┼────────┤
    │ gadget   │      1 │
    │ └─ gizmo │      1 │
    ╰──────────┴────────╯

    Changes you own:
    ╭──────────┬──────────────────╮
    │ change   │ next step        │
    ├──────────┼──────────────────┤
    │ gadget   │ review           │
    │ └─ gizmo │ review in parent │
    ╰──────────┴──────────────────╯

    Workspaces on this device:
    ╭──────────┬──────╮
    │ change   │ note │
    ├──────────┼──────┤
    │ gadget   │      │
    │ └─ gizmo │      │
    ╰──────────┴──────╯
    "
  `);
});

test("a landed change keeps its follow review in the todos of a covering reviewer", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await repo.cabaret("reviewing", "set", "owner");
  await repo.cabaret("mark", "--change", "gadget", "--tip", "gadget", "gadget.txt");
  await addChange(repo, "gizmo");
  await repo.cabaret("reviewing", "set", "owner");
  await repo.cabaret("land", "gizmo", "--even-though-unreviewed");
  // gadget was covered when gizmo landed, so the land settled gizmo's diff
  // to gizmo's own log: the landed change stays in the review todos until
  // the catch-up.
  expect((await repo.cabaret("home")).stdout).toMatchInlineSnapshot(`
    "Home
    ====

    Changes to review:
    ╭──────────┬────────╮
    │ change   │ review │
    ├──────────┼────────┤
    │ gadget   │        │
    │ └─ gizmo │      1 │
    ╰──────────┴────────╯

    Changes you own:
    ╭────────┬───────────╮
    │ change │ next step │
    ├────────┼───────────┤
    │ gadget │ land      │
    ╰────────┴───────────╯

    Workspaces on this device:
    ╭──────────┬────────╮
    │ change   │ note   │
    ├──────────┼────────┤
    │ gadget   │        │
    │ └─ gizmo │ landed │
    ╰──────────┴────────╯
    "
  `);
});

test("a landed change owes nothing when its diff reads in the parent's catch-up", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await repo.cabaret("reviewing", "set", "owner");
  await addChange(repo, "gizmo");
  await repo.cabaret("reviewing", "set", "owner");
  await repo.cabaret("land", "gizmo", "--even-though-unreviewed", "--even-though-parent-unreviewed");
  // gadget was not covered at the land, so the land completed gizmo's own
  // review: its diff reads combined into gadget's catch-up, and only gadget
  // asks, with both files.
  expect((await repo.cabaret("home")).stdout).toMatchInlineSnapshot(`
    "Home
    ====

    Changes to review:
    ╭────────┬────────╮
    │ change │ review │
    ├────────┼────────┤
    │ gadget │      2 │
    ╰────────┴────────╯

    Changes you own:
    ╭────────┬───────────╮
    │ change │ next step │
    ├────────┼───────────┤
    │ gadget │ review    │
    ╰────────┴───────────╯

    Workspaces on this device:
    ╭──────────┬────────╮
    │ change   │ note   │
    ├──────────┼────────┤
    │ gadget   │        │
    │ └─ gizmo │ landed │
    ╰──────────┴────────╯
    "
  `);
});

test("a change with conflict markers asks no review, only its fix", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await repo.cabaret("reviewing", "set", "owner");
  await repo.write("gadget.txt", "<<<<<<< ours\ngadget work\n=======\nother\n>>>>>>> parent\n");
  await repo.git("commit", "-qam", "conflicted");
  expect((await repo.cabaret("home")).stdout).toMatchInlineSnapshot(`
    "Home
    ====

    Changes to review:
    ╭────────┬────────╮
    │ change │ review │
    ├────────┼────────┤
    ╰────────┴────────╯

    Changes you own:
    ╭────────┬───────────────╮
    │ change │ next step     │
    ├────────┼───────────────┤
    │ gadget │ fix conflicts │
    ╰────────┴───────────────╯

    Workspaces on this device:
    ╭────────┬──────╮
    │ change │ note │
    ├────────┼──────┤
    │ gadget │      │
    ╰────────┴──────╯
    "
  `);
});

test("home counts an alias's changes among the user's own", async () => {
  const repo = await makeRepo();
  await repo.git("config", "user.email", "agent@example.com");
  await addChange(repo, "gizmo");
  await repo.cabaret("reviewing", "set", "owner");
  await repo.git("config", "user.email", "alice@example.com");
  // Someone else's change: alice neither owns gizmo nor owes it review.
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
    ╭────────┬──────╮
    │ change │ note │
    ├────────┼──────┤
    │ gizmo  │      │
    ╰────────┴──────╯
    "
  `);
  // Declared an alias, the agent's change is alice's own, and its owner
  // self-review — still the agent's to give — is owed through her.
  await repo.git("config", "--add", "cabaret.alias", "agent@example.com");
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
    │ gizmo  │      │
    ╰────────┴──────╯
    "
  `);
});

test("an adopted change reads, reviews, and materializes without ever running fetch", async () => {
  const repo = await makeRepo();
  await requireReviewers(repo, "bob@example.com");
  await addChange(repo, "gadget");
  await repo.cabaret("reviewing", "set", "everyone");
  await repo.git("push", "-q", "origin", "main", "gadget", "refs/cabaret/log/*:refs/cabaret/log/*");
  // The clone holds gadget's log and origin's copy of its branch, but no
  // local branch: the state adoption leaves a second machine in.
  const clone = await makeClone(repo, "bob@example.com");
  await clone.git("fetch", "-q", "origin", "+refs/cabaret/log/*:refs/cabaret/log/*");
  const { stdout, stderr, exitCode } = await clone.cabaret("home");
  expect({ stderr, exitCode }).toEqual({ stderr: "", exitCode: 0 });
  expect(stdout).toMatchInlineSnapshot(`
    "Home
    ====

    Changes to review:
    ╭────────┬────────╮
    │ change │ review │
    ├────────┼────────┤
    │ gadget │      1 │
    ╰────────┴────────╯

    Changes you own:
    ╭────────┬───────────╮
    │ change │ next step │
    ├────────┼───────────┤
    ╰────────┴───────────╯

    Workspaces on this device:
    ╭────────┬──────╮
    │ change │ note │
    ├────────┼──────┤
    │ master │      │
    ╰────────┴──────╯

    fetched 20w ago
    "
  `);
  // Review marks record revisions, not branches, so reviewing needs no branch.
  await clone.cabaret("mark", "--tip", "gadget", "gadget.txt", "--change", "gadget");
  expect((await clone.cabaret("home")).stdout).toMatchInlineSnapshot(`
    "Home
    ====

    Changes to review:
    ╭────────┬────────╮
    │ change │ review │
    ├────────┼────────┤
    │ gadget │      1 │
    ╰────────┴────────╯

    Changes you own:
    ╭────────┬───────────╮
    │ change │ next step │
    ├────────┼───────────┤
    ╰────────┴───────────╯

    Workspaces on this device:
    ╭────────┬──────╮
    │ change │ note │
    ├────────┼──────┤
    │ master │      │
    ╰────────┴──────╯

    fetched 20w ago
    "
  `);
  // An operation that moves the branch creates it from origin's copy.
  await clone.cabaret("rebase", "gadget", "--even-though-not-owner");
  expect(await clone.git("rev-parse", "refs/heads/gadget")).toBe(
    await clone.git("rev-parse", "refs/remotes/origin/gadget"),
  );
});

test("a change whose branch is gone goes to stderr without blocking the page", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await addChange(repo, "gizmo");
  await repo.cabaret("reviewing", "set", "owner");
  // Deleting the branch orphans gadget's log: the change can no longer be
  // read, while gizmo — parented on the missing branch — still can.
  await repo.git("branch", "-qD", "gadget");
  const { stdout, stderr, exitCode } = await repo.cabaret("home");
  expect({ stderr, exitCode }).toEqual({
    stderr: 'gadget: "gadget" does not exist\n',
    exitCode: 0,
  });
  expect(stdout).toMatchInlineSnapshot(`
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
    │ gizmo  │ reparent  │
    ╰────────┴───────────╯

    Workspaces on this device:
    ╭────────┬──────╮
    │ change │ note │
    ├────────┼──────┤
    │ gizmo  │      │
    ╰────────┴──────╯
    "
  `);
});

test("home with no changes shows both sections empty", async () => {
  const repo = await makeRepo();
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
    ╭────────┬──────╮
    │ change │ note │
    ├────────┼──────┤
    │ main   │      │
    ╰────────┴──────╯
    "
  `);
});

test("fetch imports an open forge change, and home lists it when review is owed", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  // The policy on main is what puts the imported change on this user's plate.
  await requireReviewers(repo, "alice@example.com");
  await addChange(repo, "gadget");
  await repo.cabaret("reviewing", "set", "owner");
  // A teammate's branch lives on origin and in a forge change, but not locally.
  await repo.git("checkout", "-q", "main");
  await repo.git("checkout", "-qb", "their-feature");
  await repo.write("their.txt", "their work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "their work");
  await repo.git("push", "-q", "origin", "their-feature");
  await repo.git("checkout", "-q", "gadget");
  await repo.git("branch", "-qD", "their-feature");
  forge.openPr("carol", parseBranchName("their-feature"), parseBranchName("main"), "Their feature");
  await repo.cabaret("fetch");
  expect((await repo.cabaret("home")).stdout).toMatchInlineSnapshot(`
    "Home
    ====

    Changes to review:
    ╭───────────────┬────────╮
    │ change        │ review │
    ├───────────────┼────────┤
    │ gadget        │      1 │
    │ their-feature │      1 │
    ╰───────────────┴────────╯

    Changes you own:
    ╭────────┬───────────╮
    │ change │ next step │
    ├────────┼───────────┤
    │ gadget │ review    │
    ╰────────┴───────────╯

    Workspaces on this device:
    ╭────────┬──────╮
    │ change │ note │
    ├────────┼──────┤
    │ gadget │      │
    ╰────────┴──────╯

    fetched 20w ago
    "
  `);
});

test("your own forge change joins the changes you own through the recorded alias", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await repo.git("checkout", "-qb", "solo-feature");
  await repo.write("solo.txt", "solo work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "solo work");
  await repo.git("push", "-q", "origin", "solo-feature");
  await repo.git("checkout", "-q", "main");
  forge.openPr("alice", parseBranchName("solo-feature"), parseBranchName("main"), "Solo feature");
  await repo.cabaret("fetch");
  expect((await repo.cabaret("home")).stdout).toMatchInlineSnapshot(`
    "Home
    ====

    Changes to review:
    ╭──────────────┬────────╮
    │ change       │ review │
    ├──────────────┼────────┤
    │ solo-feature │      1 │
    ╰──────────────┴────────╯

    Changes you own:
    ╭──────────────┬───────────╮
    │ change       │ next step │
    ├──────────────┼───────────┤
    │ solo-feature │ review    │
    ╰──────────────┴───────────╯

    Workspaces on this device:
    ╭────────┬──────╮
    │ change │ note │
    ├────────┼──────┤
    │ main   │      │
    ╰────────┴──────╯

    fetched 20w ago
    "
  `);
});

test("a merged forge change is not imported", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  const id = forge.openPr("carol", parseBranchName("their-feature"), parseBranchName("main"), "Their feature");
  forge.merge(id, parseCommitHash(await repo.git("rev-parse", "main")));
  await repo.cabaret("fetch");
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
    ╭────────┬──────╮
    │ change │ note │
    ├────────┼──────┤
    │ main   │      │
    ╰────────┴──────╯
    "
  `);
});

test("a landed change stays only while children hang from it", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await addChange(repo, "gizmo");
  await repo.cabaret("reviewing", "set", "owner");
  await repo.cabaret("mark", "--tip", "gadget", "gadget.txt", "--change", "gadget");
  await repo.cabaret("land", "gadget");
  // The land moved gizmo onto main; hang it back to keep the landed gadget in view.
  await repo.cabaret("reparent", "gizmo", "gadget", "--even-though-parent-archived");
  expect((await repo.cabaret("home")).stdout).toMatchInlineSnapshot(`
    "Home
    ====

    Changes to review:
    ╭──────────┬────────╮
    │ change   │ review │
    ├──────────┼────────┤
    │ gadget   │        │
    │ └─ gizmo │      1 │
    ╰──────────┴────────╯

    Changes you own:
    ╭──────────┬───────────╮
    │ change   │ next step │
    ├──────────┼───────────┤
    │ gadget   │ landed    │
    │ └─ gizmo │ reparent  │
    ╰──────────┴───────────╯

    Workspaces on this device:
    ╭──────────┬──────╮
    │ change   │ note │
    ├──────────┼──────┤
    │ gadget   │      │
    │ └─ gizmo │      │
    ╰──────────┴──────╯
    "
  `);
});

test("someone else's change obliging nothing of the user is not review work", async () => {
  const repo = await makeRepo();
  await repo.git("config", "user.email", "bob@example.com");
  await addChange(repo, "gadget");
  await repo.git("config", "user.email", "alice@example.com");
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
    ╭────────┬──────╮
    │ change │ note │
    ├────────┼──────┤
    │ gadget │      │
    ╰────────┴──────╯
    "
  `);
});

test("review is owed only while an obligation is unsatisfied", async () => {
  const repo = await makeRepo();
  await requireReviewers(repo, "alice@example.com", "bob@example.com");
  await repo.git("config", "user.email", "bob@example.com");
  await addChange(repo, "feature");
  // Obligations only reach home pages once the reviewing set includes their users.
  await repo.cabaret("reviewing", "set", "everyone");
  await repo.git("config", "user.email", "alice@example.com");
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
    ╭─────────┬──────╮
    │ change  │ note │
    ├─────────┼──────┤
    │ feature │      │
    ╰─────────┴──────╯
    "
  `);
  await repo.git("config", "user.email", "bob@example.com");
  await repo.cabaret("mark", "--tip", "HEAD", "feature.txt");
  await repo.git("config", "user.email", "alice@example.com");
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

test("a landed change with no children drops out entirely", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await repo.cabaret("mark", "--tip", "HEAD", "gadget.txt");
  await repo.cabaret("land", "gadget");
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
    │ gadget │ landed │
    ╰────────┴────────╯
    "
  `);
});

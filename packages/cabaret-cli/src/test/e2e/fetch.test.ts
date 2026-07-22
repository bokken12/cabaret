import { expect, test } from "vitest";
import { addChange, makeClone, makeRepo, shownComments, shownLog } from "./fixture.js";

test("fetch carries a change's log to a fresh machine verbatim", async () => {
  const alice = await makeRepo();
  await addChange(alice, "widgets");
  await alice.cabaret("mark", "--tip", "HEAD", "widgets.txt");
  await alice.git("push", "-q", "origin", "main");
  expect(await alice.cabaret("fetch")).toEqual({
    stdout: "synced 1 change with origin\n",
    stderr: "",
    exitCode: 0,
  });

  const bob = await makeClone(alice, "bob@example.com");
  expect(await bob.cabaret("fetch")).toEqual({
    stdout: "synced 1 change with origin\n",
    stderr: "",
    exitCode: 0,
  });
  const _root = await alice.git("rev-parse", "main");
  const _tip = await alice.git("rev-parse", "widgets");
  const log = await shownLog(alice, "widgets");
  expect(await shownLog(bob, "widgets")).toBe(log);
  expect(log).toMatchInlineSnapshot(`
    "{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}
    {"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"1ac0b33426d0417f90ab4eb5ec771b5067e09a9b"}}
    {"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}
    {"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}
    {"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"everyone"}}
    {"timestamp":1748000000005,"user":"alice@example.com","action":{"kind":"review","file":"widgets.txt","base":"1ac0b33426d0417f90ab4eb5ec771b5067e09a9b","tip":"9deb95270887a6eac741083f431a3b653dc6b656"}}
    "
  `);
});

test("concurrent work on two machines merges into one identical log", async () => {
  const alice = await makeRepo();
  await addChange(alice, "widgets");
  await alice.git("push", "-q", "origin", "main");
  await alice.cabaret("fetch");
  const bob = await makeClone(alice, "bob@example.com");
  await bob.cabaret("fetch");

  // Concurrently: neither machine has seen the other's comment.
  await alice.cabaret("comment", "does this handle empty diffs?", "--change", "widgets");
  await bob.cabaret("comment", "looks good overall", "--change", "widgets");
  await alice.cabaret("fetch");
  await bob.cabaret("fetch");
  await alice.cabaret("fetch");

  const aliceLog = await alice.cabaret("dev", "log", "widgets");
  expect(await bob.cabaret("dev", "log", "widgets")).toEqual(aliceLog);
  expect(await shownComments(alice, "widgets")).toBe(
    "Comments:\n  2025-05-23T11:33:20.005Z alice@example.com\n    does this handle empty diffs?\n\n" +
      "  2025-05-23T11:35:00.000Z bob@example.com\n    looks good overall\n",
  );
});

test("fetch with nothing to sync reports zero changes", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("fetch")).toEqual({
    stdout: "synced 0 changes with origin\n",
    stderr: "",
    exitCode: 0,
  });
});

test("fetch fast-forwards a branch behind origin unless a dirty workspace holds it", async () => {
  const alice = await makeRepo();
  await addChange(alice, "widgets");
  await alice.git("push", "-q", "origin", "main", "widgets");
  await alice.cabaret("fetch");
  const bob = await makeClone(alice, "bob@example.com");
  await bob.git("checkout", "-q", "main");
  await bob.git("branch", "-q", "widgets", "origin/widgets");
  // Alice advances the branch; bob's local copy trails until he fetches.
  await alice.write("widgets.txt", "widgets work v2\n");
  await alice.git("commit", "-qam", "more widgets work");
  await alice.git("push", "-q", "origin", "widgets");
  expect(await bob.cabaret("fetch")).toEqual({
    stdout: 'advanced "widgets"\nsynced 1 change with origin\n',
    stderr: "",
    exitCode: 0,
  });
  expect(await bob.git("rev-parse", "widgets")).toBe(await alice.git("rev-parse", "widgets"));
  // A clean checkout is no obstacle: bob's checked-out main advances, the
  // working tree following.
  await alice.git("checkout", "-q", "main");
  await alice.write("trunk.txt", "trunk work\n");
  await alice.git("add", "-A");
  await alice.git("commit", "-qm", "trunk work");
  await alice.git("push", "-q", "origin", "main");
  expect(await bob.cabaret("fetch")).toEqual({
    stdout: 'advanced "main"\nsynced 1 change with origin\n',
    stderr: "",
    exitCode: 0,
  });
  expect(await bob.git("rev-parse", "main")).toBe(await alice.git("rev-parse", "main"));
  expect(await bob.git("status", "--porcelain")).toBe("");
  // Once the checkout is dirty, its line of work holds the branch in place.
  await bob.write("wip.txt", "work in progress\n");
  await alice.write("trunk.txt", "trunk work v2\n");
  await alice.git("commit", "-qam", "more trunk work");
  await alice.git("push", "-q", "origin", "main");
  const mainBefore = await bob.git("rev-parse", "main");
  expect(await bob.cabaret("fetch")).toEqual({
    stdout: "synced 1 change with origin\n",
    stderr: "",
    exitCode: 0,
  });
  expect(await bob.git("rev-parse", "main")).toBe(mainBefore);
});

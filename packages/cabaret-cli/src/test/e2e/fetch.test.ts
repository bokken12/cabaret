import { expect, test } from "vitest";
import { addChange, makeClone, makeRepo, shownComments } from "./fixture.js";

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
  const root = await alice.git("rev-parse", "main");
  const tip = await alice.git("rev-parse", "widgets");
  const log = {
    stdout:
      '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n' +
      `{"timestamp":1748000000001,"user":"alice@example.com","action":{"kind":"set-base","base":"${root}"}}\n` +
      '{"timestamp":1748000000002,"user":"alice@example.com","action":{"kind":"set-owner","owner":"alice@example.com"}}\n' +
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"none"}}\n' +
      `{"timestamp":1748000000004,"user":"alice@example.com","action":{"kind":"review","file":"widgets.txt","base":"${root}","tip":"${tip}"}}\n`,
    stderr: "",
    exitCode: 0,
  };
  expect(await bob.cabaret("log", "widgets")).toEqual(log);
  expect(await alice.cabaret("log", "widgets")).toEqual(log);
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

  const aliceLog = await alice.cabaret("log", "widgets");
  expect(await bob.cabaret("log", "widgets")).toEqual(aliceLog);
  expect(await shownComments(alice, "widgets")).toBe(
    "Comments:\n  2025-05-23T11:33:20.004Z alice@example.com\n    does this handle empty diffs?\n\n" +
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

test("fetch fast-forwards a branch behind origin unless a workspace holds it", async () => {
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
  // The checkout counts as a workspace: bob's checked-out main never moves
  // under him, even once it trails origin.
  await alice.git("checkout", "-q", "main");
  await alice.write("trunk.txt", "trunk work\n");
  await alice.git("add", "-A");
  await alice.git("commit", "-qm", "trunk work");
  await alice.git("push", "-q", "origin", "main");
  const mainBefore = await bob.git("rev-parse", "main");
  expect(await bob.cabaret("fetch")).toEqual({
    stdout: "synced 1 change with origin\n",
    stderr: "",
    exitCode: 0,
  });
  expect(await bob.git("rev-parse", "main")).toBe(mainBefore);
});

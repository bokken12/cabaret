import { expect, test } from "vitest";
import { addChange, makeClone, makeRepo, shownComments } from "./fixture.js";

test("sync carries a change's log to a fresh machine verbatim", async () => {
  const alice = await makeRepo();
  await addChange(alice, "widgets");
  await alice.cabaret("review", "widgets.txt");
  await alice.git("push", "-q", "origin", "main");
  expect(await alice.cabaret("sync")).toEqual({
    stdout: "synced 1 change with origin\n",
    stderr: "",
    exitCode: 0,
  });

  const bob = await makeClone(alice, "bob@example.com");
  expect(await bob.cabaret("sync")).toEqual({
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
      '{"timestamp":1748000000003,"user":"alice@example.com","action":{"kind":"set-reviewing","reviewing":"owner"}}\n' +
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
  await alice.cabaret("sync");
  const bob = await makeClone(alice, "bob@example.com");
  await bob.cabaret("sync");

  // Concurrently: neither machine has seen the other's comment.
  await alice.cabaret("comment", "does this handle empty diffs?", "--change", "widgets");
  await bob.cabaret("comment", "looks good overall", "--change", "widgets");
  await alice.cabaret("sync");
  await bob.cabaret("sync");
  await alice.cabaret("sync");

  const aliceLog = await alice.cabaret("log", "widgets");
  expect(await bob.cabaret("log", "widgets")).toEqual(aliceLog);
  expect(await shownComments(alice, "widgets")).toBe(
    "Comments:\n  2025-05-23T11:33:20.004Z alice@example.com\n    does this handle empty diffs?\n\n" +
      "  2025-05-23T11:35:00.000Z bob@example.com\n    looks good overall\n",
  );
});

test("sync with nothing to sync reports zero changes", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("sync")).toEqual({
    stdout: "synced 0 changes with origin\n",
    stderr: "",
    exitCode: 0,
  });
});

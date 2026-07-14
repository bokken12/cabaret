import { expect, test } from "vitest";
import { addChange, makeRepo } from "./fixture.js";

test("wipe deletes logs and fetched logs; branches stay", async () => {
  const repo = await makeRepo();
  await addChange(repo, "widgets");
  await repo.cabaret("review", "widgets.txt");
  await repo.cabaret("sync");

  // One change, even though its log and the fetched copy are two refs.
  expect(await repo.cabaret("dev", "wipe")).toEqual({
    stdout: "wiped the logs of 1 change\n",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("for-each-ref", "refs/cabaret/")).toBe("");
  expect(await repo.git("rev-parse", "--verify", "refs/heads/widgets")).not.toBe("");
  expect(await repo.cabaret("log", "widgets")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("wipe is local: origin keeps its logs, so sync restores them", async () => {
  const repo = await makeRepo();
  await addChange(repo, "widgets");
  await repo.cabaret("review", "widgets.txt");
  await repo.cabaret("sync");
  const before = await repo.cabaret("log", "widgets");

  await repo.cabaret("dev", "wipe");
  expect(await repo.cabaret("log", "widgets")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  await repo.cabaret("sync");
  expect(await repo.cabaret("log", "widgets")).toEqual(before);
});

test("wipe --remote deletes origin's logs too", async () => {
  const repo = await makeRepo();
  await addChange(repo, "widgets");
  await addChange(repo, "gadgets");
  await repo.cabaret("sync");

  expect(await repo.cabaret("dev", "wipe", "--remote")).toEqual({
    stdout: "wiped the logs of 2 changes\nwiped the logs of 2 changes on origin\n",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("ls-remote", "origin", "refs/cabaret/*")).toBe("");
  expect(await repo.cabaret("dev", "wipe", "--remote")).toEqual({
    stdout: "wiped the logs of 0 changes\nwiped the logs of 0 changes on origin\n",
    stderr: "",
    exitCode: 0,
  });
});

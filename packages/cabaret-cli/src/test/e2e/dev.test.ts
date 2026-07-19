import { expect, test } from "vitest";
import { addChange, makeRepo } from "./fixture.js";

test("wipe deletes logs and fetched logs; branches stay", async () => {
  const repo = await makeRepo();
  await addChange(repo, "widgets");
  await repo.cabaret("mark", "--tip", "HEAD", "widgets.txt");
  await repo.cabaret("fetch");

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

test("wipe is local: origin keeps its logs, so fetch restores them", async () => {
  const repo = await makeRepo();
  await addChange(repo, "widgets");
  await repo.cabaret("mark", "--tip", "HEAD", "widgets.txt");
  await repo.cabaret("fetch");
  const before = await repo.cabaret("log", "widgets");

  await repo.cabaret("dev", "wipe");
  expect(await repo.cabaret("log", "widgets")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  await repo.cabaret("fetch");
  expect(await repo.cabaret("log", "widgets")).toEqual(before);
});

test("wipe --remote deletes origin's logs too", async () => {
  const repo = await makeRepo();
  await addChange(repo, "widgets");
  await addChange(repo, "gadgets");
  await repo.cabaret("fetch");

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

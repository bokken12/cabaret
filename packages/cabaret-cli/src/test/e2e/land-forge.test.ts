import { forgeRequestId, parseCommitHash } from "cabaret-core";
import { expect, test } from "vitest";
import { FakeForge } from "./fake-forge.js";
import { addChange, makeRepo, type TestRepo } from "./fixture.js";

const REQUEST = forgeRequestId(1);

/**
 * A repo whose change `gadget` (one commit adding gadget.txt) has an open PR
 * against main, with main pushed so the forge can merge into it. Leaves HEAD
 * on `gadget`.
 */
async function makeRequested(forge: FakeForge): Promise<TestRepo> {
  const repo = await makeRepo(forge);
  await repo.git("push", "-q", "origin", "main");
  await addChange(repo, "gadget");
  await repo.cabaret("review", "gadget.txt");
  await repo.cabaret("gh", "push");
  return repo;
}

test("land merges the change's PR on the forge and fetches the result", async () => {
  const forge = new FakeForge();
  const repo = await makeRequested(forge);
  const tip = await repo.git("rev-parse", "gadget");
  const mainBefore = await repo.git("rev-parse", "main");
  expect(await repo.cabaret("land")).toEqual({
    stdout: "merged github.com/test-org/widgets#1\n",
    stderr: "",
    exitCode: 0,
  });
  // The forge created the land merge on its main; the land fetched it home,
  // trailer and all, so the parent's reviewers skip the diff it brings in.
  const merge = await repo.git("rev-parse", "main");
  expect(await repo.git("rev-parse", "main^1", "main^2")).toBe(`${mainBefore}\n${tip}`);
  expect(await repo.git("log", "--format=%B", "-1", "main")).toBe("Land gadget\n\nCabaret-Landed: gadget");
  expect((await repo.git("ls-remote", "origin", "main")).split("\t")[0]).toBe(merge);
  expect((await forge.getRequest(REQUEST)).state).toBe("merged");
  expect((await repo.cabaret("log")).stdout).toContain(`{"kind":"land","merge":"${merge}"}`);
});

test("land squashes the change's PR on the forge when configured", async () => {
  const forge = new FakeForge();
  const repo = await makeRequested(forge);
  await repo.git("config", "cabaret.landMethod", "squash");
  const tip = await repo.git("rev-parse", "gadget");
  const mainBefore = await repo.git("rev-parse", "main");
  expect(await repo.cabaret("land")).toEqual({
    stdout: "merged github.com/test-org/widgets#1\n",
    stderr: "",
    exitCode: 0,
  });
  const squash = await repo.git("rev-parse", "main");
  expect(await repo.git("show", "--no-patch", "--format=%P", "main")).toBe(mainBefore);
  expect(await repo.git("log", "--format=%B", "-1", "main")).toBe("Land gadget\n\nCabaret-Landed: gadget");
  expect(await repo.git("show", "main:gadget.txt")).toBe("gadget work");
  expect((await repo.cabaret("log")).stdout).toContain(`{"kind":"land","merge":"${squash}","tip":"${tip}"}`);
});

test("land stays local when cabaret.landVia is local, request or not", async () => {
  const forge = new FakeForge();
  const repo = await makeRequested(forge);
  await repo.git("config", "cabaret.landVia", "local");
  const mainOnForge = await repo.git("ls-remote", "origin", "main");
  expect(await repo.cabaret("land")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  // Local main took the land merge; the forge saw nothing.
  expect(await repo.git("log", "--format=%B", "-1", "main")).toBe("Land gadget\n\nCabaret-Landed: gadget");
  expect(await repo.git("ls-remote", "origin", "main")).toBe(mainOnForge);
  expect((await forge.getRequest(REQUEST)).state).toBe("open");
});

test("land via forge without a pull request fails", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await repo.git("push", "-q", "origin", "main");
  await addChange(repo, "gadget");
  await repo.git("config", "cabaret.landVia", "forge");
  expect(await repo.cabaret("land")).toEqual({
    stdout: "",
    stderr: 'no pull request for "gadget" on github.com/test-org/widgets; run `cabaret gh push` first\n',
    exitCode: 1,
  });
});

test("land via forge refuses a PR behind the local tip", async () => {
  const forge = new FakeForge();
  const repo = await makeRequested(forge);
  await repo.write("gadget.txt", "gadget work, more\n");
  await repo.git("commit", "-qam", "more gadget work");
  await repo.cabaret("review", "gadget.txt");
  expect(await repo.cabaret("land")).toEqual({
    stdout: "",
    stderr: 'github.com/test-org/widgets#1 is not at "gadget"\'s tip; run `cabaret gh push` first\n',
    exitCode: 1,
  });
  expect((await forge.getRequest(REQUEST)).state).toBe("open");
});

test("land via forge records the land another machine can pull", async () => {
  const forge = new FakeForge();
  const repo = await makeRequested(forge);
  await repo.cabaret("land");
  const merge = parseCommitHash(await repo.git("rev-parse", "main"));
  // A rerun of gh pull adds nothing: the land is already recorded.
  expect((await repo.cabaret("gh", "pull")).stdout).toBe("pulled 0 comments from github.com/test-org/widgets#1\n");
  expect((await repo.cabaret("log")).stdout.split("\n").filter((line) => line.includes('"kind":"land"'))).toHaveLength(
    1,
  );
  expect((await repo.cabaret("log")).stdout).toContain(`{"kind":"land","merge":"${merge}"}`);
});

test("land via forge from the parent's checkout fast-forwards it, working tree included", async () => {
  const forge = new FakeForge();
  const repo = await makeRequested(forge);
  await repo.git("checkout", "-q", "main");
  expect(await repo.cabaret("land", "gadget")).toEqual({
    stdout: "merged github.com/test-org/widgets#1\n",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("symbolic-ref", "--short", "HEAD")).toBe("main");
  expect(await repo.git("log", "--format=%B", "-1", "main")).toBe("Land gadget\n\nCabaret-Landed: gadget");
  // The checked-out main fast-forwarded for real: the file is on disk.
  expect(await repo.git("status", "--porcelain")).toBe("");
  expect(await repo.git("show", "HEAD:gadget.txt")).toBe("gadget work");
});

import { parseBranchName } from "cabaret-core";
import { expect, test } from "vitest";
import { FakeForge } from "./fake-forge.js";
import { addChange, makeClone, makeRepo, shownLog } from "./fixture.js";

test("name set renames the branch locally and on origin, and resolution follows", async () => {
  const repo = await makeRepo();
  await repo.git("push", "-q", "origin", "main");
  await addChange(repo, "gadget");
  await repo.git("push", "-q", "origin", "gadget");
  expect(await repo.cabaret("name", "set", "widget", "--change", "gadget")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("branch", "--list", "gadget")).toBe("");
  expect(await repo.git("rev-parse", "widget")).toBe((await repo.git("ls-remote", "origin", "widget")).split("\t")[0]);
  expect(await repo.git("ls-remote", "origin", "gadget")).toBe("");
  expect((await shownLog(repo, "widget")).trim().split("\n").at(-1)).toBe(
    '{"timestamp":1748000000006,"user":"alice@example.com","action":{"kind":"set-name","name":"widget"}}',
  );
  // The old name no longer answers; the id designates the change throughout.
  expect((await repo.cabaret("name", "show", "--change", "gadget")).exitCode).toBe(1);
  expect(await repo.cabaret("name", "show", "--change", "00000000")).toEqual({
    stdout: "widget\n",
    stderr: "",
    exitCode: 0,
  });
});

test("name set renames a draft origin never held without touching origin", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "gadget");
  expect(await repo.cabaret("name", "set", "widget", "--change", "gadget")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("branch", "--list", "gadget")).toBe("");
  expect(await repo.git("ls-remote", "origin", "widget", "gadget")).toBe("");
  expect(await repo.cabaret("name", "show", "--change", "widget")).toEqual({
    stdout: "widget\n",
    stderr: "",
    exitCode: 0,
  });
});

test("name set recreates the forge change the rename closes", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await repo.git("push", "-q", "origin", "main");
  await addChange(repo, "gadget");
  await repo.cabaret("sync");
  // The forge closes #1 with the head rename; a fresh #2 tracks the new head.
  expect(await repo.cabaret("name", "set", "widget", "--change", "gadget")).toEqual({
    stdout: "opened github.com/test-org/widgets#2\n",
    stderr: "",
    exitCode: 0,
  });
  const pr = await forge.findChange(parseBranchName("widget"));
  expect({ id: pr?.id, state: pr?.state }).toEqual({ id: 2, state: "open" });
  expect(await forge.findChange(parseBranchName("gadget"))).toBeUndefined();
  expect(await repo.git("ls-remote", "origin", "gadget")).toBe("");
  expect(await repo.git("branch", "--list", "gadget")).toBe("");
  // The next fetch reads the renamed change steadily: still live, tracked by
  // the fresh forge change — the closed #1 archives nothing.
  const fetched = await repo.cabaret("fetch");
  expect(fetched.stderr).toBe("");
  expect((await repo.cabaret("show", "widget")).stdout).toContain("│ reviewing    │ everyone");
  expect(await repo.cabaret("name", "show", "--change", "widget")).toEqual({
    stdout: "widget\n",
    stderr: "",
    exitCode: 0,
  });
});

test("name set refuses a taken name, an existing branch, and a foreign change", async () => {
  const repo = await makeRepo();
  await repo.cabaret("create", "gadget");
  await repo.cabaret("create", "widget");
  expect(await repo.cabaret("name", "set", "widget", "--change", "gadget")).toEqual({
    stdout: "",
    stderr: 'change already exists: "widget"\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("name", "set", "main", "--change", "gadget")).toEqual({
    stdout: "",
    stderr: 'branch already exists: "main"\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("name", "set", "gadget", "--change", "gadget")).toEqual({
    stdout: "",
    stderr: 'change is already named "gadget"\n',
    exitCode: 1,
  });
  await repo.cabaret("owner", "set", "bob@example.com", "--change", "gadget", "--even-though-not-owner");
  expect(await repo.cabaret("name", "set", "sprocket", "--change", "gadget")).toEqual({
    stdout: "",
    stderr:
      '"gadget" is owned by "bob@example.com", not "alice@example.com"; pass --even-though-not-owner to override\n',
    exitCode: 1,
  });
});

test("fetch nudges when a fetched log collides with a live local name", async () => {
  const repo = await makeRepo();
  await repo.git("push", "-q", "origin", "main");
  const other = await makeClone(repo, "bob@example.com");
  expect((await other.cabaret("create", "shared", "--parent", "main")).exitCode).toBe(0);
  expect((await other.cabaret("sync", "--change", "shared")).exitCode).toBe(0);
  expect((await repo.cabaret("create", "shared")).exitCode).toBe(0);
  const { stderr, exitCode } = await repo.cabaret("fetch");
  expect(exitCode).toBe(0);
  expect(stderr).toBe(
    'warning: multiple live changes are named "shared": 00000000, 01000000; rename one with `cab name set`\n',
  );
});

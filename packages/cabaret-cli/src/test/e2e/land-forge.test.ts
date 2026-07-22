import { forgeChangeId, parseCommitHash } from "cabaret-core";
import { expect, test } from "vitest";
import { FakeForge } from "./fake-forge.js";
import { addChange, makeRepo, type TestRepo } from "./fixture.js";

const PR = forgeChangeId(1);

/**
 * A repo whose change `gadget` (one commit adding gadget.txt) has an open forge change
 * against main, with main pushed so the forge can merge into it. Leaves HEAD
 * on `gadget`.
 */
async function makePr(forge: FakeForge): Promise<TestRepo> {
  const repo = await makeRepo(forge);
  await repo.git("push", "-q", "origin", "main");
  await addChange(repo, "gadget");
  await repo.cabaret("mark", "--tip", "HEAD", "gadget.txt");
  await repo.cabaret("sync");
  return repo;
}

test("land merges the change's forge change and fetches the result", async () => {
  const forge = new FakeForge();
  const repo = await makePr(forge);
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
  expect(await repo.git("log", "--format=%B", "-1", "main")).toBe(
    "Land gadget\n\nCabaret-Landed: 00000000000000000000000000000001",
  );
  expect((await repo.git("ls-remote", "origin", "main")).split("\t")[0]).toBe(merge);
  expect((await forge.getChange(PR)).state).toBe("merged");
  expect((await repo.cabaret("dev", "log")).stdout).toContain(`{"kind":"land","merge":"${merge}"}`);
});

test("a forge land reparents the landed change's children", async () => {
  const forge = new FakeForge();
  const repo = await makePr(forge);
  await repo.cabaret("create", "doodad", "--parent", "gadget");
  expect(await repo.cabaret("land")).toEqual({
    stdout: 'merged github.com/test-org/widgets#1\nreparented "doodad" onto "main"\n',
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("dev", "log", "doodad")).stdout).toContain(
    '"action":{"kind":"set-parent","parent":"main"}',
  );
});

test("a forge land retargets the children's forge changes", async () => {
  const forge = new FakeForge();
  const repo = await makePr(forge);
  await addChange(repo, "doodad");
  await repo.cabaret("mark", "--tip", "HEAD", "doodad.txt");
  await repo.cabaret("reviewing", "set", "everyone");
  await repo.cabaret("sync");
  expect(await repo.cabaret("land", "gadget")).toEqual({
    stdout:
      "merged github.com/test-org/widgets#1\n" +
      'reparented "doodad" onto "main"\n' +
      'retargeted github.com/test-org/widgets#2 onto "main"\n',
    stderr: "",
    exitCode: 0,
  });
  expect((await forge.getChange(forgeChangeId(2))).parent).toBe("main");
  // The new parent is recorded as an observation, so the child stops reading
  // its forge change as targeting the landed branch and needing a sync.
  expect((await repo.cabaret("dev", "log", "doodad")).stdout).toContain(
    '"source":{"forge":"github.com/test-org/widgets"},"action":{"kind":"set-parent","parent":"main"}',
  );
  expect((await repo.cabaret("show", "doodad")).stdout).toMatchInlineSnapshot(`
    "doodad
    ======

    ╭──────────────┬───────────────────────────────╮
    │ attribute    │ value                         │
    ├──────────────┼───────────────────────────────┤
    │ next step    │ land                          │
    │ owner        │ alice@example.com             │
    │ reviewing    │ everyone                      │
    │ parent       │ main                          │
    │ forge change │ github.com/test-org/widgets#2 │
    │ tip          │ 377deca3f07c                  │
    │ base         │ f37230616d25 (behind parent)  │
    │ workspace    │ .                             │
    ╰──────────────┴───────────────────────────────╯

    fetched 00:00, 2025-01-01
    "
  `);
});

test("land settles a pending retarget before merging", async () => {
  const forge = new FakeForge();
  const repo = await makePr(forge);
  // A second landable parent, present on the forge so it can merge into it.
  await repo.git("branch", "develop", "main");
  await repo.git("push", "-q", "origin", "develop");
  // The reparent happens offline, so its write-through cannot carry it; the
  // land's own reconcile settles the forge change before merging.
  const origin = await repo.git("remote", "get-url", "origin");
  await repo.git("remote", "set-url", "origin", "ssh://127.0.0.1:1/offline.git");
  expect((await repo.cabaret("reparent", "gadget", "develop")).stdout).toBe("origin unreachable; sync to publish\n");
  await repo.git("remote", "set-url", "origin", origin);
  expect(await repo.cabaret("land")).toEqual({
    stdout: "merged github.com/test-org/widgets#1\n",
    stderr: "",
    exitCode: 0,
  });
  expect((await forge.getChange(PR)).parent).toBe("develop");
  expect((await forge.getChange(PR)).state).toBe("merged");
  expect((await repo.cabaret("dev", "log")).stdout).toContain(
    '"source":{"forge":"github.com/test-org/widgets"},"action":{"kind":"set-parent","parent":"develop"}',
  );
});

test("land squashes the change's forge change when configured", async () => {
  const forge = new FakeForge();
  const repo = await makePr(forge);
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
  expect(await repo.git("log", "--format=%B", "-1", "main")).toBe(
    "Land gadget\n\nCabaret-Landed: 00000000000000000000000000000001",
  );
  expect(await repo.git("show", "main:gadget.txt")).toBe("gadget work");
  expect((await repo.cabaret("dev", "log")).stdout).toContain(`{"kind":"land","merge":"${squash}","tip":"${tip}"}`);
});

test("land stays off the forge when cabaret.landVia is local, forge change or not", async () => {
  const forge = new FakeForge();
  const repo = await makePr(forge);
  await repo.git("config", "cabaret.landVia", "local");
  expect(await repo.cabaret("land")).toEqual({ stdout: 'pushed "main" to origin\n', stderr: "", exitCode: 0 });
  // Local main took the land merge and pushed it; the forge change itself was
  // never merged.
  expect(await repo.git("log", "--format=%B", "-1", "main")).toBe(
    "Land gadget\n\nCabaret-Landed: 00000000000000000000000000000001",
  );
  expect((await repo.git("ls-remote", "origin", "main")).split("\t")[0]).toBe(await repo.git("rev-parse", "main"));
  expect((await forge.getChange(PR)).state).toBe("open");
});

test("land via forge without a forge change fails", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await repo.git("push", "-q", "origin", "main");
  await addChange(repo, "gadget");
  await repo.git("config", "cabaret.landVia", "forge");
  expect(await repo.cabaret("land")).toEqual({
    stdout: "",
    stderr: 'no forge change for "gadget" on github.com/test-org/widgets; run `cab sync` first\n',
    exitCode: 1,
  });
});

test("land via forge refuses a forge change behind the local tip", async () => {
  const forge = new FakeForge();
  const repo = await makePr(forge);
  await repo.write("gadget.txt", "gadget work, more\n");
  await repo.git("commit", "-qam", "more gadget work");
  await repo.cabaret("mark", "--tip", "HEAD", "gadget.txt");
  expect(await repo.cabaret("land")).toEqual({
    stdout: "",
    stderr: 'github.com/test-org/widgets#1 is not at "gadget"\'s tip; run `cab sync` first\n',
    exitCode: 1,
  });
  expect((await forge.getChange(PR)).state).toBe("open");
});

test("land via forge records the land another machine can fetch", async () => {
  const forge = new FakeForge();
  const repo = await makePr(forge);
  await repo.cabaret("land");
  const merge = parseCommitHash(await repo.git("rev-parse", "main"));
  // A rerun of fetch adds nothing: the land is already recorded, so the
  // sweep passes the change by.
  expect((await repo.cabaret("fetch")).stdout).toBe(
    "recorded github:alice as an alias\n" + "fetched github.com/test-org/widgets: 0 open forge changes\n",
  );
  expect(
    (await repo.cabaret("dev", "log")).stdout.split("\n").filter((line) => line.includes('"kind":"land"')),
  ).toHaveLength(1);
  expect((await repo.cabaret("dev", "log")).stdout).toContain(`{"kind":"land","merge":"${merge}"}`);
});

test("land via forge from the parent's checkout fast-forwards it, working tree included", async () => {
  const forge = new FakeForge();
  const repo = await makePr(forge);
  await repo.git("checkout", "-q", "main");
  expect(await repo.cabaret("land", "gadget")).toEqual({
    stdout: "merged github.com/test-org/widgets#1\n",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("symbolic-ref", "--short", "HEAD")).toBe("main");
  expect(await repo.git("log", "--format=%B", "-1", "main")).toBe(
    "Land gadget\n\nCabaret-Landed: 00000000000000000000000000000001",
  );
  // The checked-out main fast-forwarded for real: the file is on disk.
  expect(await repo.git("status", "--porcelain")).toBe("");
  expect(await repo.git("show", "HEAD:gadget.txt")).toBe("gadget work");
});

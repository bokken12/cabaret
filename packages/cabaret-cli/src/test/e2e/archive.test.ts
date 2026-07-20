import { forgeChangeId } from "cabaret-core";
import { expect, test } from "vitest";
import { FakeForge } from "./fake-forge.js";
import { addChange, makeRepo } from "./fixture.js";

const PR = forgeChangeId(1);

test("an archived change leaves the home page and archive --undo brings it back", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await repo.cabaret("reviewing", "owner");
  await repo.cabaret("archive");
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
    ╭────────┬──────────╮
    │ change │ note     │
    ├────────┼──────────┤
    │ gadget │ archived │
    ╰────────┴──────────╯
    "
  `);
  await repo.cabaret("archive", "--undo");
  expect((await repo.cabaret("home")).stdout).toMatchInlineSnapshot(`
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
    │ gadget │ review    │
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

test("show reads an archived change's next step as archived, demanding no review", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await repo.cabaret("archive");
  expect((await repo.cabaret("show")).stdout).toMatchInlineSnapshot(`
    "gadget
    ======

    ╭───────────┬───────────────────╮
    │ attribute │ value             │
    ├───────────┼───────────────────┤
    │ next step │ archived          │
    │ owner     │ alice@example.com │
    │ reviewing │ none              │
    │ parent    │ main              │
    │ tip       │ f37230616d25      │
    │ base      │ 1ac0b33426d0      │
    │ workspace │ .                 │
    ╰───────────┴───────────────────╯

    Files to review:
      gadget.txt
    "
  `);
});

test("land refuses an archived change until it is unarchived", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await repo.cabaret("archive");
  expect(await repo.cabaret("land", "--even-though-unreviewed")).toEqual({
    stdout: "",
    stderr: 'change is archived: "gadget"; run `cabaret archive --undo`\n',
    exitCode: 1,
  });
  await repo.cabaret("archive", "--undo");
  expect((await repo.cabaret("land", "--even-though-unreviewed")).exitCode).toBe(0);
});

test("land refuses a change whose parent is archived", async () => {
  const repo = await makeRepo();
  await addChange(repo, "parent");
  await addChange(repo, "child");
  await repo.cabaret("archive", "--change", "parent");
  expect(await repo.cabaret("land", "--even-though-unreviewed")).toEqual({
    stdout: "",
    stderr: 'change is archived: "parent"; run `cabaret archive --undo`\n',
    exitCode: 1,
  });
  expect(await repo.cabaret("land", "main..child", "--even-though-unreviewed")).toEqual({
    stdout: "",
    stderr:
      '"child" would land into "parent", which is archived; run `cabaret archive --undo` or `cabaret reparent` first\n',
    exitCode: 1,
  });
});

test("archive refuses a landed change", async () => {
  const repo = await makeRepo();
  await addChange(repo, "gadget");
  await repo.cabaret("land", "--even-though-unreviewed");
  const merge = await repo.git("rev-parse", "main");
  expect(await repo.cabaret("archive")).toEqual({
    stdout: "",
    stderr: `change has landed: "gadget" (land ${merge})\n`,
    exitCode: 1,
  });
});

test("sync closes the forge change of an archived change, and reopens on undo", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("sync");
  await repo.cabaret("archive");
  expect((await repo.cabaret("sync")).stdout).toBe(
    'closed github.com/test-org/widgets#1\nsynced "gadget" with github.com/test-org/widgets#1\n',
  );
  expect((await forge.getChange(PR)).state).toBe("closed");
  // The close was observed; syncing again moves nothing, and a fetch mirrors
  // nothing back.
  expect((await repo.cabaret("sync")).stdout).toBe('synced "gadget" with github.com/test-org/widgets#1\n');
  expect((await repo.cabaret("fetch")).stdout).toBe(
    "recorded github:alice as an alias\nfetched github.com/test-org/widgets: 0 open forge changes\n",
  );
  // A reparent recorded while archived reaches the forge in the same sync
  // that reopens it.
  await repo.git("branch", "develop", "main");
  await repo.cabaret("reparent", "gadget", "develop");
  await repo.cabaret("archive", "--undo");
  expect((await repo.cabaret("sync")).stdout).toBe(
    'reopened github.com/test-org/widgets#1\nsynced "gadget" with github.com/test-org/widgets#1\n',
  );
  const reopened = await forge.getChange(PR);
  expect({ state: reopened.state, parent: reopened.parent }).toEqual({ state: "open", parent: "develop" });
});

test("sync absorbs a forge-side close as an archive instead of reopening", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("sync");
  forge.close(PR);
  expect(await repo.cabaret("sync")).toEqual({
    stdout:
      "github.com/test-org/widgets#1 was closed; archived the change\n" +
      'synced "gadget" with github.com/test-org/widgets#1\n',
    stderr: "",
    exitCode: 0,
  });
  expect((await forge.getChange(PR)).state).toBe("closed");
  expect((await repo.cabaret("dev", "log")).stdout).toContain(
    '"source":{"forge":"github.com/test-org/widgets"},"action":{"kind":"set-archived","archived":true}',
  );
});

test("sync opens no forge change for an archived change", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("archive");
  expect(await repo.cabaret("sync")).toEqual({
    stdout: 'synced "gadget" with origin\n',
    stderr: "",
    exitCode: 0,
  });
  expect(await forge.fetchOpenChanges()).toEqual([]);
});

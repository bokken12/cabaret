import { forgeChangeId, parseBranchName, parseCommitHash } from "cabaret-core";
import { expect, test } from "vitest";
import { FakeForge } from "./fake-forge.js";
import { addChange, makeRepo, shownLog, type TestRepo } from "./fixture.js";

const PR1 = forgeChangeId(1);
const PR2 = forgeChangeId(2);

/**
 * A repo whose permanent change `umbrella` (one commit adding umbrella.txt)
 * has an open forge change against main, with main pushed so the forge can
 * merge into it. Leaves HEAD on `umbrella`.
 */
async function makeUmbrella(forge: FakeForge): Promise<TestRepo> {
  const repo = await makeRepo(forge);
  await repo.git("push", "-q", "origin", "main");
  await addChange(repo, "umbrella");
  await repo.cabaret("permanent", "set", "true");
  await repo.cabaret("mark", "--tip", "HEAD", "umbrella.txt");
  await repo.cabaret("sync");
  return repo;
}

test("a landed permanent change opens a fresh forge change for its next cycle", async () => {
  const forge = new FakeForge();
  const repo = await makeUmbrella(forge);
  await repo.cabaret("reviewers", "add", "github:bob");
  await repo.cabaret("sync");
  expect((await forge.getChange(PR1)).reviewers).toEqual(["github:bob"]);
  expect(await repo.cabaret("land", "--even-though-unreviewed")).toEqual({
    stdout: "merged github.com/test-org/widgets#1\n",
    stderr: "",
    exitCode: 0,
  });
  // The landed cycle's forge change is history: while the next cycle's diff
  // is empty, syncing opens nothing.
  const idle = await repo.cabaret("sync");
  expect(idle.exitCode).toBe(0);
  expect(idle.stdout).not.toContain("opened");
  await repo.write("umbrella.txt", "umbrella work v2\n");
  await repo.git("commit", "-qam", "second cycle");
  const busy = await repo.cabaret("sync");
  expect(busy.stdout).toContain("opened github.com/test-org/widgets#2");
  const second = await forge.getChange(PR2);
  expect({ head: second.head, parent: second.parent, state: second.state }).toEqual({
    head: "umbrella",
    parent: "main",
    state: "open",
  });
  // The reviewer spans cycles: the first cycle's observations ended with it,
  // so the standing intent pushes afresh instead of mirroring in as removed.
  expect(second.reviewers).toEqual(["github:bob"]);
  expect((await forge.getChange(PR1)).state).toBe("merged");
  const log = await shownLog(repo, "umbrella");
  expect(log).toContain('"action":{"kind":"set-forge","forge":"github.com/test-org/widgets","id":1}');
  expect(log).toContain('"action":{"kind":"set-forge","forge":"github.com/test-org/widgets","id":2}');
});

test("a fetched forge-side merge advances a permanent change into its next cycle", async () => {
  const forge = new FakeForge();
  const repo = await makeUmbrella(forge);
  const tip = parseCommitHash(await repo.git("rev-parse", "umbrella"));
  await forge.landChange(PR1, "merge", tip, "Land umbrella", "Cabaret-Landed: umbrella");
  expect((await repo.cabaret("fetch")).stdout).toContain("github.com/test-org/widgets#1 was merged; recorded the land");
  const forgeChange = await forge.getChange(PR1);
  const merge = forgeChange.merge?.commit;
  if (merge === undefined) {
    throw new Error("PR1 did not merge");
  }
  // The branch advanced to the landing and the base pinned there, exactly as
  // a local land advances them: an empty diff, ready for the next cycle.
  expect(await repo.git("rev-parse", "umbrella")).toBe(merge);
  const log = await shownLog(repo, "umbrella");
  expect(log).toContain(`"action":{"kind":"land","merge":"${merge}"}`);
  expect(log).toContain(`"action":{"kind":"set-base","base":"${merge}"}`);
  expect(log).not.toContain('"set-archived"');
  // The next sweep finds the cycle empty and opens nothing.
  expect((await repo.cabaret("fetch")).stdout).not.toContain("opened");
});

test("no forge change opens before a change has commits of its own", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await repo.git("push", "-q", "origin", "main");
  await repo.cabaret("create", "gizmo");
  await repo.cabaret("reviewing", "set", "everyone", "--change", "gizmo");
  await repo.git("checkout", "-q", "gizmo");
  const empty = await repo.cabaret("sync");
  expect(empty.exitCode).toBe(0);
  expect(empty.stdout).not.toContain("opened");
  await repo.write("gizmo.txt", "gizmo work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "gizmo work");
  expect((await repo.cabaret("sync")).stdout).toContain("opened github.com/test-org/widgets#1");
});

test("a merge made while untracked mirrors in as the land, matched by commit", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await repo.git("push", "-q", "origin", "main");
  await repo.cabaret("create", "gadget");
  await repo.git("checkout", "-q", "gadget");
  await repo.write("gadget.txt", "gadget work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "gadget work");
  await repo.git("push", "-q", "origin", "gadget");
  // An earlier fetch leaves a cursor, so the next sweep reads what moved
  // since — merged forge changes included, which an open sweep never lists.
  await repo.cabaret("fetch");
  // A teammate opens and merges the forge change; this clone never linked it.
  const tip = parseCommitHash(await repo.git("rev-parse", "gadget"));
  const id = forge.openPr("bob", parseBranchName("gadget"), parseBranchName("main"), "gadget");
  await forge.landChange(id, "merge", tip, "Land gadget", "Cabaret-Landed: gadget");
  expect((await repo.cabaret("fetch")).stdout).toContain("github.com/test-org/widgets#1 was merged; recorded the land");
  const log = await shownLog(repo, "gadget");
  const forgeChange = await forge.getChange(id);
  expect(log).toContain(`"action":{"kind":"land","merge":"${forgeChange.merge?.commit}"}`);
  expect(log).toContain(
    '"source":{"forge":"github.com/test-org/widgets"},"action":{"kind":"set-archived","archived":true}',
  );
  // Recorded once: the next sweep matches the merge to its land entry.
  expect((await repo.cabaret("fetch")).stdout).not.toContain("was merged");
});

test("comments stay with their cycle's forge change", async () => {
  const forge = new FakeForge();
  const repo = await makeUmbrella(forge);
  await repo.cabaret("comment", "first cycle note");
  await repo.cabaret("sync");
  expect(await forge.listComments(PR1)).toHaveLength(1);
  await repo.cabaret("land", "--even-though-unreviewed");
  await repo.write("umbrella.txt", "umbrella work v2\n");
  await repo.git("commit", "-qam", "second cycle");
  await repo.cabaret("comment", "second cycle note");
  expect((await repo.cabaret("sync")).stdout).toContain("opened github.com/test-org/widgets#2");
  // The first cycle's discussion stays on its own forge change.
  expect(await forge.listComments(PR1)).toHaveLength(1);
  const posted = await forge.listComments(PR2);
  expect(posted.map(({ body }) => body)).toEqual([
    expect.stringMatching(/^second cycle note\n\n<!-- cabaret:[0-9a-f]{64} -->$/),
  ]);
});

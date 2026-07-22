import { forgeChangeId, parseCommitHash } from "cabaret-core";
import { expect, test } from "vitest";
import { FakeForge } from "./fake-forge.js";
import { addChange, makeRepo, shownLog, type TestRepo } from "./fixture.js";

const PR1 = forgeChangeId(1);
const PR2 = forgeChangeId(2);

/**
 * A repo with change `child` (one commit adding child.txt, open as PR1
 * against `parent`) stacked on change `parent` (one commit adding
 * parent.txt, self-reviewed unless `markParent` says otherwise), with both
 * branches at origin so the forge can merge. Leaves HEAD on `child`.
 */
async function makeForgeStack(forge: FakeForge, markParent = true): Promise<TestRepo> {
  const repo = await makeRepo(forge);
  await repo.git("push", "-q", "origin", "main");
  await repo.cabaret("create", "parent");
  await repo.git("checkout", "-q", "parent");
  await repo.write("parent.txt", "parent v1\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "parent work");
  await repo.git("push", "-q", "origin", "parent");
  await repo.cabaret("create", "child");
  await repo.git("checkout", "-q", "child");
  await repo.write("child.txt", "child work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "child work");
  if (markParent) {
    await repo.cabaret("mark", "--change", "parent", "--tip", "parent", "parent.txt");
  }
  await repo.cabaret("reviewing", "set", "everyone");
  await repo.cabaret("sync");
  return repo;
}

test("an observed land settles the landed diff's review into the logs", async () => {
  // Parent covered: the observed land writes the review of the landed file
  // through the merge into the parent's log, and the child's log keeps its
  // review open as the child's own.
  const coveredForge = new FakeForge();
  const covered = await makeForgeStack(coveredForge);
  const parentBase = await covered.git("rev-parse", "main");
  const coveredTip = parseCommitHash(await covered.git("rev-parse", "child"));
  await coveredForge.landChange(PR1, "merge", coveredTip, "Land child", "Cabaret-Landed: child");
  expect((await covered.cabaret("fetch")).stdout).toContain("#1 was merged; recorded the land");
  const merge = (await coveredForge.getChange(PR1)).merge?.commit;
  expect((await covered.cabaret("dev", "log", "parent")).stdout).toContain(
    `"action":{"kind":"review","file":"child.txt","base":"${parentBase}","tip":"${merge}"}`,
  );
  expect((await covered.cabaret("dev", "log", "child")).stdout).not.toContain('"kind":"review"');
  // Parent still owed: the observed land instead completes the child's
  // review in its own log — its diff reads combined in the parent — and
  // writes the parent nothing.
  const owingForge = new FakeForge();
  const owing = await makeForgeStack(owingForge, false);
  const childBase = await owing.git("rev-parse", "parent");
  const childTip = parseCommitHash(await owing.git("rev-parse", "child"));
  await owingForge.landChange(PR1, "merge", childTip, "Land child", "Cabaret-Landed: child");
  expect((await owing.cabaret("fetch")).stdout).toContain("#1 was merged; recorded the land");
  expect((await owing.cabaret("dev", "log", "child")).stdout).toContain(
    `"user":"alice@example.com","action":{"kind":"review","file":"child.txt","base":"${childBase}","tip":"${childTip}"}`,
  );
  expect((await owing.cabaret("dev", "log", "parent")).stdout).not.toContain('"kind":"review"');
});

test("an observed land walks the landed change's children to its parent", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await repo.git("push", "-q", "origin", "main");
  await addChange(repo, "gadget");
  await repo.cabaret("mark", "--tip", "HEAD", "gadget.txt");
  await repo.cabaret("sync");
  await addChange(repo, "doodad");
  await repo.cabaret("sync");
  expect((await forge.getChange(PR2)).parent).toBe("gadget");
  const tip = parseCommitHash(await repo.git("rev-parse", "gadget"));
  await forge.landChange(PR1, "merge", tip, "Land gadget", "Cabaret-Landed: gadget");
  const fetched = (await repo.cabaret("fetch")).stdout;
  expect(fetched).toContain("github.com/test-org/widgets#1 was merged; recorded the land");
  expect(fetched).toContain('reparented "doodad" onto "main"');
  // The child follows the code to main, its forge change retargeted with it.
  expect((await repo.cabaret("dev", "log", "doodad")).stdout).toContain(
    '"action":{"kind":"set-parent","parent":"main"}',
  );
  expect((await forge.getChange(PR2)).parent).toBe("main");
  const log = await shownLog(repo, "gadget");
  expect(log).toContain('"kind":"land"');
  expect(log).toContain('"kind":"set-archived","archived":true');
});

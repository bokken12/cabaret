import { forgeChangeId, parseCommitHash, parseRefName, type RefName } from "cabaret-core";
import { expect, test } from "vitest";
import { FakeForge } from "./fake-forge.js";
import { addChange, makeClone, makeRepo, shownComments, type TestRepo } from "./fixture.js";

const PR = forgeChangeId(1);

test("gh push pushes the branch, opens a PR on the parent, and posts comments with markers", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("comment", "ship it");
  expect(await repo.cabaret("gh", "push")).toEqual({
    stdout: "opened github.com/test-org/widgets#1\npushed 1 comment to github.com/test-org/widgets#1\n",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("ls-remote", "--heads", "origin", "gadget")).toContain("refs/heads/gadget");
  expect(await forge.getChange(PR)).toEqual({
    id: PR,
    head: "gadget",
    tip: parseCommitHash(await repo.git("rev-parse", "gadget")),
    parent: "main",
    title: "gadget",
    author: "alice@users.noreply.github.com",
    state: "open",
  });
  const posted = await forge.listComments(PR);
  expect(posted.map(({ body }) => body)).toEqual([expect.stringMatching(/^ship it\n\n<!-- cabaret:[0-9a-f]{64} -->$/)]);
  expect((await repo.cabaret("log")).stdout).toContain(
    '"action":{"kind":"set-forge","forge":"github.com/test-org/widgets","id":1}',
  );
});

test("gh push again is a no-op", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("comment", "ship it");
  await repo.cabaret("gh", "push");
  expect(await repo.cabaret("gh", "push")).toEqual({
    stdout: "pushed 0 comments to github.com/test-org/widgets#1\n",
    stderr: "",
    exitCode: 0,
  });
  expect(await forge.listComments(PR)).toHaveLength(1);
});

test("gh push attributes another user's comment to its author", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.git("config", "user.email", "bob@example.com");
  await repo.cabaret("comment", "one nit");
  await repo.git("config", "user.email", "alice@example.com");
  await repo.cabaret("gh", "push");
  const posted = await forge.listComments(PR);
  expect(posted.map(({ body }) => body)).toEqual([
    expect.stringMatching(/^\*\*bob@example\.com:\*\*\n\none nit\n\n<!-- cabaret:[0-9a-f]{64} -->$/),
  ]);
});

test("gh pull imports comments under forge identities, and again is a no-op", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("gh", "push");
  forge.comment(PR, "carol", "does this handle empty diffs?");
  expect(await repo.cabaret("gh", "pull")).toEqual({
    stdout: "pulled 1 comment from github.com/test-org/widgets#1\n" + "synced github.com/test-org/widgets: 1 open PR\n",
    stderr: "",
    exitCode: 0,
  });
  expect(await shownComments(repo)).toBe(
    "Comments:\n  2025-06-15T15:06:40.000Z carol@users.noreply.github.com\n    does this handle empty diffs?\n",
  );
  expect(await repo.cabaret("gh", "pull")).toEqual({
    stdout:
      "pulled 0 comments from github.com/test-org/widgets#1\n" + "synced github.com/test-org/widgets: 1 open PR\n",
    stderr: "",
    exitCode: 0,
  });
});

test("gh pull imports a forge-side edit as a new version, displayed once", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("gh", "push");
  const commentId = forge.comment(PR, "carol", "looks wrong");
  await repo.cabaret("gh", "pull");
  forge.edit(PR, commentId, "looks wrong (never mind)");
  expect((await repo.cabaret("gh", "pull")).stdout).toBe(
    "pulled 1 comment from github.com/test-org/widgets#1\n" + "synced github.com/test-org/widgets: 1 open PR\n",
  );
  expect(await shownComments(repo)).toBe(
    "Comments:\n  2025-06-15T15:06:40.001Z carol@users.noreply.github.com\n    looks wrong (never mind)\n",
  );
});

test("gh pull does not echo comments gh push posted", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.git("config", "user.email", "bob@example.com");
  await repo.cabaret("comment", "one nit");
  await repo.git("config", "user.email", "alice@example.com");
  await repo.cabaret("comment", "ship it");
  await repo.cabaret("gh", "push");
  expect((await repo.cabaret("gh", "pull")).stdout).toBe(
    "pulled 0 comments from github.com/test-org/widgets#1\n" + "synced github.com/test-org/widgets: 1 open PR\n",
  );
  expect(await shownComments(repo)).toBe(
    "Comments:\n  2025-05-23T11:33:20.003Z bob@example.com\n    one nit\n\n" +
      "  2025-05-23T11:33:20.004Z alice@example.com\n    ship it\n",
  );
});

test("gh pull records a merged PR as landing the change, once", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("gh", "push");
  const merge = parseCommitHash(await repo.git("rev-parse", "main"));
  forge.merge(PR, merge);
  expect(await repo.cabaret("gh", "pull")).toEqual({
    stdout:
      "github.com/test-org/widgets#1 was merged; recorded the land\n" +
      "pulled 0 comments from github.com/test-org/widgets#1\n" +
      "synced github.com/test-org/widgets: 0 open PRs\n",
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("log")).stdout).toContain(`"action":{"kind":"land","merge":"${merge}"}`);
  // The landed change is done: the next sweep passes it by.
  expect((await repo.cabaret("gh", "pull")).stdout).toBe("synced github.com/test-org/widgets: 0 open PRs\n");
});

test("gh pull records a squash-merged PR with the tip that merged", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("gh", "push");
  const tip = await repo.git("rev-parse", "gadget");
  // The squash commit descends from no reviewed history, so the land entry
  // freezes the head that merged as the change's tip.
  const squash = parseCommitHash("1".repeat(40));
  forge.merge(PR, squash, 1);
  expect((await repo.cabaret("gh", "pull")).stdout).toContain("was merged; recorded the land");
  expect((await repo.cabaret("log")).stdout).toContain(`"action":{"kind":"land","merge":"${squash}","tip":"${tip}"}`);
});

test("gh pull adopts the branch's open PR when the log names none", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await forge.createChange(parseRefName("gadget"), parseRefName("main"), "gadget");
  forge.comment(PR, "carol", "opened this by hand");
  expect((await repo.cabaret("gh", "pull")).stdout).toBe(
    "pulled 1 comment from github.com/test-org/widgets#1\n" + "synced github.com/test-org/widgets: 1 open PR\n",
  );
  expect((await repo.cabaret("log")).stdout).toContain(
    '"action":{"kind":"set-forge","forge":"github.com/test-org/widgets","id":1}',
  );
});

test("gh pull --change fails when the change has no PR", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  expect(await repo.cabaret("gh", "pull", "--change", "gadget")).toEqual({
    stdout: "",
    stderr: 'no PR for "gadget" on github.com/test-org/widgets; run `cabaret gh push` first\n',
    exitCode: 1,
  });
  // The sweep just passes such a change by.
  expect(await repo.cabaret("gh", "pull")).toEqual({
    stdout: "synced github.com/test-org/widgets: 0 open PRs\n",
    stderr: "",
    exitCode: 0,
  });
});

test("gh push does not record forge activity, even an observed merge", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("gh", "push");
  forge.merge(PR, parseCommitHash(await repo.git("rev-parse", "main")));
  expect(await repo.cabaret("gh", "push")).toEqual({
    stdout: "pushed 0 comments to github.com/test-org/widgets#1\n",
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("log")).stdout).not.toContain('"kind":"land"');
});

/** A teammate's branch, committed and pushed to origin but absent locally, as a PR's head would be. */
async function pushTeammateBranch(repo: TestRepo, branch: RefName): Promise<string> {
  await repo.git("checkout", "-qb", branch);
  await repo.write(`${branch}.txt`, `${branch} work\n`);
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", `${branch} work`);
  await repo.git("push", "-q", "origin", branch);
  const tip = await repo.git("rev-parse", branch);
  await repo.git("checkout", "-q", "main");
  await repo.git("branch", "-qD", branch);
  return tip;
}

test("gh pull turns a teammate's PR into a change to review", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  const theirTip = await pushTeammateBranch(repo, parseRefName("their-feature"));
  const id = forge.openPr("carol", parseRefName("their-feature"), parseRefName("main"), "Their feature");
  forge.comment(id, "carol", "please take a look");
  expect(await repo.cabaret("gh", "pull")).toEqual({
    stdout:
      'imported github.com/test-org/widgets#1 as "their-feature" with 1 comment\n' +
      "synced github.com/test-org/widgets: 1 open PR\n",
    stderr: "",
    exitCode: 0,
  });
  // The branch is local again, and the change belongs to its author.
  expect(await repo.git("rev-parse", "--verify", "their-feature")).toBe(theirTip);
  expect(await shownComments(repo, "their-feature")).toBe(
    "Comments:\n  2025-06-15T15:06:40.000Z carol@users.noreply.github.com\n    please take a look\n",
  );
  const log = (await repo.cabaret("log", "their-feature")).stdout;
  expect(log).toContain('"action":{"kind":"set-parent","parent":"main","source":"github.com/test-org/widgets"}');
  expect(log).toContain('"action":{"kind":"set-owner","owner":"carol@users.noreply.github.com"}');
  expect(log).toContain('"action":{"kind":"set-forge","forge":"github.com/test-org/widgets","id":1}');
  // The import published: origin holds the log, and pulling again refreshes
  // the change rather than re-importing it.
  expect(await repo.git("ls-remote", "origin", "refs/cabaret/log/their-feature")).not.toBe("");
  expect((await repo.cabaret("gh", "pull")).stdout).toBe(
    "pulled 0 comments from github.com/test-org/widgets#1\n" + "synced github.com/test-org/widgets: 1 open PR\n",
  );
});

test("gh pull adopts the PR of an existing local branch without fetching it", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  // The PR was opened from this very checkout, so its branch is both local
  // and current. A local branch is never fetched into — git refuses when
  // any worktree has it checked out, and import should not move it anyway.
  await repo.git("checkout", "-qb", "my-feature");
  await repo.write("mine.txt", "my work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "my work");
  await repo.git("push", "-q", "origin", "my-feature");
  forge.openPr("alice", parseRefName("my-feature"), parseRefName("main"), "My feature");
  expect(await repo.cabaret("gh", "pull")).toEqual({
    stdout:
      'imported github.com/test-org/widgets#1 as "my-feature" with 0 comments\n' +
      "synced github.com/test-org/widgets: 1 open PR\n",
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("log", "my-feature")).stdout).toContain(
    '"action":{"kind":"set-owner","owner":"alice@users.noreply.github.com"}',
  );
});

test("a second machine's pull adopts the published import instead of re-importing", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await repo.git("push", "-q", "origin", "main");
  await pushTeammateBranch(repo, parseRefName("their-feature"));
  forge.openPr("carol", parseRefName("their-feature"), parseRefName("main"), "Their feature");
  await repo.cabaret("gh", "pull");
  const clone = await makeClone(repo, "bob@example.com", forge);
  expect((await clone.cabaret("gh", "pull")).stdout).toBe(
    "pulled 0 comments from github.com/test-org/widgets#1\n" + "synced github.com/test-org/widgets: 1 open PR\n",
  );
  // Byte-identical logs: the clone adopted the import rather than re-creating it.
  expect(await clone.cabaret("log", "their-feature")).toEqual(await repo.cabaret("log", "their-feature"));
});

test("gh pull reads a capped discussion in full before importing", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  forge.commentCap = 1;
  await pushTeammateBranch(repo, parseRefName("their-feature"));
  const id = forge.openPr("carol", parseRefName("their-feature"), parseRefName("main"), "Their feature");
  forge.comment(id, "carol", "first thought");
  forge.comment(id, "carol", "second thought");
  expect((await repo.cabaret("gh", "pull")).stdout).toContain(
    'imported github.com/test-org/widgets#1 as "their-feature" with 2 comments\n',
  );
});

test("gh pull skips a PR whose branch cannot be fetched", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  // The PR's branch never reached origin, so there is nothing to fetch.
  forge.openPr("carol", parseRefName("phantom"), parseRefName("main"), "Phantom");
  expect(await repo.cabaret("gh", "pull")).toEqual({
    stdout: "synced github.com/test-org/widgets: 1 open PR\n",
    stderr: 'warning: skipping github.com/test-org/widgets#1 ("phantom"): branch "phantom" could not be fetched\n',
    exitCode: 0,
  });
  expect((await repo.cabaret("log", "phantom")).stdout).toBe("");
});

test("gh pull prunes a closed PR's change when nobody engaged with it", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await pushTeammateBranch(repo, parseRefName("their-feature"));
  const id = forge.openPr("carol", parseRefName("their-feature"), parseRefName("main"), "Their feature");
  await repo.cabaret("gh", "pull");
  forge.close(id);
  expect(await repo.cabaret("gh", "pull")).toEqual({
    stdout:
      'github.com/test-org/widgets#1 was closed; removed unreviewed change "their-feature"\n' +
      "synced github.com/test-org/widgets: 0 open PRs\n",
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("log", "their-feature")).stdout).toBe("");
  expect(await repo.git("ls-remote", "origin", "refs/cabaret/log/their-feature")).toBe("");
});

test("gh pull keeps a closed PR's change once someone engaged with it", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await pushTeammateBranch(repo, parseRefName("their-feature"));
  const id = forge.openPr("carol", parseRefName("their-feature"), parseRefName("main"), "Their feature");
  await repo.cabaret("gh", "pull");
  await repo.cabaret("review", "their-feature.txt", "--change", "their-feature");
  forge.close(id);
  expect((await repo.cabaret("gh", "pull")).stdout).toBe("synced github.com/test-org/widgets: 0 open PRs\n");
  expect((await repo.cabaret("log", "their-feature")).stdout).toContain('"kind":"review"');
});

test("gh pull mirrors a forge-side retarget into the change", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("gh", "push");
  // A teammate retargets the PR on the forge, as GitHub itself does when a
  // stacked PR's base branch merges.
  await forge.setParent(PR, parseRefName("develop"));
  expect((await repo.cabaret("gh", "pull")).stdout).toBe(
    'github.com/test-org/widgets#1 was retargeted; reparented onto "develop"\n' +
      "pulled 0 comments from github.com/test-org/widgets#1\n" +
      "synced github.com/test-org/widgets: 1 open PR\n",
  );
  expect((await repo.cabaret("log")).stdout).toContain(
    '"action":{"kind":"set-parent","parent":"develop","source":"github.com/test-org/widgets"}',
  );
  // The retarget was observed once; pulling again re-mirrors nothing.
  expect((await repo.cabaret("gh", "pull")).stdout).toBe(
    "pulled 0 comments from github.com/test-org/widgets#1\n" + "synced github.com/test-org/widgets: 1 open PR\n",
  );
});

test("gh pull leaves an unpushed local reparent alone", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("gh", "push");
  await repo.cabaret("reparent", "gadget", "develop");
  // The forge still shows the parent the push left, which is not a retarget.
  expect((await repo.cabaret("gh", "pull")).stdout).toBe(
    "pulled 0 comments from github.com/test-org/widgets#1\n" + "synced github.com/test-org/widgets: 1 open PR\n",
  );
  const log = (await repo.cabaret("log")).stdout.trimEnd().split("\n");
  expect(log[log.length - 1]).toContain('"action":{"kind":"set-parent","parent":"develop"}');
});

test("gh push retargets the PR base after a reparent", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await addChange(repo, "widget");
  await repo.cabaret("gh", "push");
  expect((await forge.getChange(PR)).parent).toBe("gadget");
  await repo.cabaret("reparent", "widget", "main");
  await repo.cabaret("gh", "push");
  expect((await forge.getChange(PR)).parent).toBe("main");
});

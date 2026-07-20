import { type ChangeName, forgeChangeId, parseBranchName, parseCommitHash } from "cabaret-core";
import { expect, test } from "vitest";
import { FakeForge } from "./fake-forge.js";
import { addChange, makeClone, makeRepo, shownComments, type TestRepo } from "./fixture.js";

const PR = forgeChangeId(1);

test("sync pushes the branch, opens a forge change on the parent, and posts comments with markers", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("comment", "ship it");
  expect(await repo.cabaret("sync")).toEqual({
    stdout:
      "opened github.com/test-org/widgets#1\n" +
      "posted 1 comment to github.com/test-org/widgets#1\n" +
      'synced "gadget" with github.com/test-org/widgets#1\n',
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
    author: "github:alice",
    state: "open",
    // A fresh change is a draft until widened, and opens as one.
    draft: true,
    reviewers: [],
  });
  const posted = await forge.listComments(PR);
  expect(posted.map(({ body }) => body)).toEqual([expect.stringMatching(/^ship it\n\n<!-- cabaret:[0-9a-f]{64} -->$/)]);
  expect((await repo.cabaret("dev", "log")).stdout).toContain(
    '"action":{"kind":"set-forge","forge":"github.com/test-org/widgets","id":1}',
  );
});

test("sync again is a no-op", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("comment", "ship it");
  await repo.cabaret("sync");
  expect(await repo.cabaret("sync")).toEqual({
    stdout: 'synced "gadget" with github.com/test-org/widgets#1\n',
    stderr: "",
    exitCode: 0,
  });
  expect(await forge.listComments(PR)).toHaveLength(1);
});

test("sync attributes another user's comment to its author", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.git("config", "user.email", "bob@example.com");
  await repo.cabaret("comment", "one nit");
  await repo.git("config", "user.email", "alice@example.com");
  await repo.cabaret("sync");
  const posted = await forge.listComments(PR);
  expect(posted.map(({ body }) => body)).toEqual([
    expect.stringMatching(/^\*\*bob@example\.com:\*\*\n\none nit\n\n<!-- cabaret:[0-9a-f]{64} -->$/),
  ]);
});

test("fetch imports comments under forge identities, and again is a no-op", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("sync");
  forge.comment(PR, "carol", "does this handle empty diffs?");
  expect(await repo.cabaret("fetch")).toEqual({
    stdout:
      "recorded github:alice as an alias\n" +
      "fetched 1 comment from github.com/test-org/widgets#1\n" +
      "fetched github.com/test-org/widgets: 1 open forge change\n",
    stderr: "",
    exitCode: 0,
  });
  expect(await shownComments(repo)).toBe(
    "Comments:\n  2025-06-15T15:06:40.000Z github:carol\n    does this handle empty diffs?\n",
  );
  expect(await repo.cabaret("fetch")).toEqual({
    stdout:
      "fetched 0 comments from github.com/test-org/widgets#1\n" +
      "fetched github.com/test-org/widgets: 1 open forge change\n",
    stderr: "",
    exitCode: 0,
  });
});

test("fetch imports a forge-side edit as a new version, displayed once", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("sync");
  const commentId = forge.comment(PR, "carol", "looks wrong");
  await repo.cabaret("fetch");
  forge.edit(PR, commentId, "looks wrong (never mind)");
  expect((await repo.cabaret("fetch")).stdout).toBe(
    "fetched 1 comment from github.com/test-org/widgets#1\n" +
      "fetched github.com/test-org/widgets: 1 open forge change\n",
  );
  expect(await shownComments(repo)).toBe(
    "Comments:\n  2025-06-15T15:06:40.001Z github:carol\n    looks wrong (never mind)\n",
  );
});

test("fetch does not echo comments sync posted", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.git("config", "user.email", "bob@example.com");
  await repo.cabaret("comment", "one nit");
  await repo.git("config", "user.email", "alice@example.com");
  await repo.cabaret("comment", "ship it");
  await repo.cabaret("sync");
  expect((await repo.cabaret("fetch")).stdout).toBe(
    "recorded github:alice as an alias\n" +
      "fetched 0 comments from github.com/test-org/widgets#1\n" +
      "fetched github.com/test-org/widgets: 1 open forge change\n",
  );
  expect(await shownComments(repo)).toBe(
    "Comments:\n  2025-05-23T11:33:20.004Z bob@example.com\n    one nit\n\n" +
      "  2025-05-23T11:33:20.005Z alice@example.com\n    ship it\n",
  );
});

test("fetch records a merged forge change as landing the change, once", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("sync");
  const merge = parseCommitHash(await repo.git("rev-parse", "main"));
  forge.merge(PR, merge);
  expect(await repo.cabaret("fetch")).toEqual({
    stdout:
      "recorded github:alice as an alias\n" +
      "github.com/test-org/widgets#1 was merged; recorded the land\n" +
      "fetched 0 comments from github.com/test-org/widgets#1\n" +
      "fetched github.com/test-org/widgets: 0 open forge changes\n",
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("dev", "log")).stdout).toContain(`"action":{"kind":"land","merge":"${merge}"}`);
  // The landed change is done: the next sweep passes it by.
  expect((await repo.cabaret("fetch")).stdout).toBe("fetched github.com/test-org/widgets: 0 open forge changes\n");
});

test("fetch records a squash-merged forge change with the tip that merged", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("sync");
  const tip = await repo.git("rev-parse", "gadget");
  // The squash commit descends from no reviewed history, so the land entry
  // freezes the head that merged as the change's tip.
  const squash = parseCommitHash("1".repeat(40));
  forge.merge(PR, squash, 1);
  expect((await repo.cabaret("fetch")).stdout).toContain("was merged; recorded the land");
  expect((await repo.cabaret("dev", "log")).stdout).toContain(
    `"action":{"kind":"land","merge":"${squash}","tip":"${tip}"}`,
  );
});

test("sync records an observed merge as the land", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("sync");
  const merge = parseCommitHash(await repo.git("rev-parse", "main"));
  forge.merge(PR, merge);
  expect(await repo.cabaret("sync")).toEqual({
    stdout:
      "github.com/test-org/widgets#1 was merged; recorded the land\n" +
      'synced "gadget" with github.com/test-org/widgets#1\n',
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("dev", "log")).stdout).toContain(`"action":{"kind":"land","merge":"${merge}"}`);
});

test("fetch adopts the branch's open forge change when the log names none", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await forge.createChange(parseBranchName("gadget"), parseBranchName("main"), "gadget", false);
  forge.comment(PR, "carol", "opened this by hand");
  expect((await repo.cabaret("fetch")).stdout).toBe(
    "recorded github:alice as an alias\n" +
      "fetched 1 comment from github.com/test-org/widgets#1\n" +
      "fetched github.com/test-org/widgets: 1 open forge change\n",
  );
  expect((await repo.cabaret("dev", "log")).stdout).toContain(
    '"action":{"kind":"set-forge","forge":"github.com/test-org/widgets","id":1}',
  );
});

test("fetch passes by a change with no forge change", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  expect(await repo.cabaret("fetch")).toEqual({
    stdout: "recorded github:alice as an alias\n" + "fetched github.com/test-org/widgets: 0 open forge changes\n",
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("dev", "log")).stdout).not.toContain('"kind":"set-forge"');
});

/** A teammate's branch, committed and pushed to origin but absent locally, as a forge change's head would be. */
async function pushTeammateBranch(repo: TestRepo, branch: ChangeName): Promise<string> {
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

test("fetch turns a teammate's forge change into a change to review", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  const theirTip = await pushTeammateBranch(repo, parseBranchName("their-feature"));
  const id = forge.openPr("carol", parseBranchName("their-feature"), parseBranchName("main"), "Their feature");
  forge.comment(id, "carol", "please take a look");
  expect(await repo.cabaret("fetch")).toEqual({
    stdout:
      "recorded github:alice as an alias\n" +
      'imported github.com/test-org/widgets#1 as "their-feature" with 1 comment\n' +
      "fetched github.com/test-org/widgets: 1 open forge change\n",
    stderr: "",
    exitCode: 0,
  });
  // No local branch is created: the change reads origin's copy until an
  // operation needs the branch. The change belongs to its author.
  await expect(repo.git("rev-parse", "--verify", "refs/heads/their-feature")).rejects.toThrow();
  expect(await repo.git("rev-parse", "refs/remotes/origin/their-feature")).toBe(theirTip);
  expect(await shownComments(repo, "their-feature")).toBe(
    "Comments:\n  2025-06-15T15:06:40.000Z github:carol\n    please take a look\n",
  );
  const log = (await repo.cabaret("dev", "log", "their-feature")).stdout;
  expect(log).toContain(
    '"source":{"forge":"github.com/test-org/widgets"},"action":{"kind":"set-parent","parent":"main"}',
  );
  expect(log).toContain('"action":{"kind":"set-owner","owner":"github:carol"}');
  expect(log).toContain('"action":{"kind":"set-forge","forge":"github.com/test-org/widgets","id":1}');
  // The import published: origin holds the log, and fetching again refreshes
  // the change rather than re-importing it.
  expect(await repo.git("ls-remote", "origin", "refs/cabaret/log/their-feature")).not.toBe("");
  expect((await repo.cabaret("fetch")).stdout).toBe(
    "fetched 0 comments from github.com/test-org/widgets#1\n" +
      "fetched github.com/test-org/widgets: 1 open forge change\n",
  );
});

test("fetch adopts the forge change of an existing local branch without fetching it", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  // The forge change was opened from this very checkout, so its branch is both local
  // and current. A local branch is never fetched into — git refuses when
  // any worktree has it checked out, and import should not move it anyway.
  await repo.git("checkout", "-qb", "my-feature");
  await repo.write("mine.txt", "my work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "my work");
  await repo.git("push", "-q", "origin", "my-feature");
  forge.openPr("alice", parseBranchName("my-feature"), parseBranchName("main"), "My feature");
  expect(await repo.cabaret("fetch")).toEqual({
    stdout:
      "recorded github:alice as an alias\n" +
      'imported github.com/test-org/widgets#1 as "my-feature" with 0 comments\n' +
      "fetched github.com/test-org/widgets: 1 open forge change\n",
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("dev", "log", "my-feature")).stdout).toContain(
    '"action":{"kind":"set-owner","owner":"github:alice"}',
  );
});

test("a second machine's fetch adopts the published import instead of re-importing", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await repo.git("push", "-q", "origin", "main");
  await pushTeammateBranch(repo, parseBranchName("their-feature"));
  forge.openPr("carol", parseBranchName("their-feature"), parseBranchName("main"), "Their feature");
  await repo.cabaret("fetch");
  const clone = await makeClone(repo, "bob@example.com", forge);
  // The second machine holds its own token.
  forge.tokenLogin = "bob";
  expect((await clone.cabaret("fetch")).stdout).toBe(
    "recorded github:bob as an alias\n" +
      "fetched 0 comments from github.com/test-org/widgets#1\n" +
      "fetched github.com/test-org/widgets: 1 open forge change\n",
  );
  // Byte-identical logs: the clone adopted the import rather than re-creating it.
  expect(await clone.cabaret("dev", "log", "their-feature")).toEqual(await repo.cabaret("dev", "log", "their-feature"));
});

test("fetch records the account's public email as an alias too, once", async () => {
  const forge = new FakeForge();
  forge.tokenEmail = "alice@work.example.com";
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("sync");
  expect((await repo.cabaret("fetch")).stdout).toBe(
    "recorded github:alice as an alias\n" +
      "recorded alice@work.example.com as an alias\n" +
      "fetched 0 comments from github.com/test-org/widgets#1\n" +
      "fetched github.com/test-org/widgets: 1 open forge change\n",
  );
  expect((await repo.cabaret("fetch")).stdout).toBe(
    "fetched 0 comments from github.com/test-org/widgets#1\n" +
      "fetched github.com/test-org/widgets: 1 open forge change\n",
  );
});

test("fetch does not record a public email that is already you", async () => {
  const forge = new FakeForge();
  // makeRepo's identity: the account's public email adds nothing.
  forge.tokenEmail = "alice@example.com";
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("sync");
  expect((await repo.cabaret("fetch")).stdout).toBe(
    "recorded github:alice as an alias\n" +
      "fetched 0 comments from github.com/test-org/widgets#1\n" +
      "fetched github.com/test-org/widgets: 1 open forge change\n",
  );
});

test("fetch reads a capped discussion in full before importing", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  forge.commentCap = 1;
  await pushTeammateBranch(repo, parseBranchName("their-feature"));
  const id = forge.openPr("carol", parseBranchName("their-feature"), parseBranchName("main"), "Their feature");
  forge.comment(id, "carol", "first thought");
  forge.comment(id, "carol", "second thought");
  expect((await repo.cabaret("fetch")).stdout).toContain(
    'imported github.com/test-org/widgets#1 as "their-feature" with 2 comments\n',
  );
});

test("fetch skips a forge change whose branch origin does not have", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  // The forge change's branch never reached origin, so there is nothing to read.
  forge.openPr("carol", parseBranchName("phantom"), parseBranchName("main"), "Phantom");
  expect(await repo.cabaret("fetch")).toEqual({
    stdout: "recorded github:alice as an alias\n" + "fetched github.com/test-org/widgets: 1 open forge change\n",
    stderr: 'warning: skipping github.com/test-org/widgets#1 ("phantom"): origin has no branch "phantom"\n',
    exitCode: 0,
  });
  expect((await repo.cabaret("dev", "log", "phantom")).stdout).toBe("");
});

test("fetch prunes the change of a closed forge change when nobody engaged with it", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await pushTeammateBranch(repo, parseBranchName("their-feature"));
  const id = forge.openPr("carol", parseBranchName("their-feature"), parseBranchName("main"), "Their feature");
  await repo.cabaret("fetch");
  forge.close(id);
  expect(await repo.cabaret("fetch")).toEqual({
    stdout:
      'github.com/test-org/widgets#1 was closed; removed unreviewed change "their-feature"\n' +
      "fetched github.com/test-org/widgets: 0 open forge changes\n",
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("dev", "log", "their-feature")).stdout).toBe("");
  expect(await repo.git("ls-remote", "origin", "refs/cabaret/log/their-feature")).toBe("");
});

test("fetch archives the change of a closed forge change once someone engaged with it", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await pushTeammateBranch(repo, parseBranchName("their-feature"));
  const id = forge.openPr("carol", parseBranchName("their-feature"), parseBranchName("main"), "Their feature");
  await repo.cabaret("fetch");
  await repo.cabaret("mark", "--tip", "origin/their-feature", "their-feature.txt", "--change", "their-feature");
  forge.close(id);
  expect((await repo.cabaret("fetch")).stdout).toBe(
    'github.com/test-org/widgets#1 was closed; archived "their-feature"\n' +
      "fetched github.com/test-org/widgets: 0 open forge changes\n",
  );
  const log = (await repo.cabaret("dev", "log", "their-feature")).stdout;
  expect(log).toContain('"kind":"review"');
  expect(log).toContain(
    '"source":{"forge":"github.com/test-org/widgets"},"action":{"kind":"set-archived","archived":true}',
  );
  // The close was observed once; fetching again re-mirrors nothing.
  expect((await repo.cabaret("fetch")).stdout).toBe("fetched github.com/test-org/widgets: 0 open forge changes\n");
});

test("fetch unarchives the change of a reopened forge change", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await pushTeammateBranch(repo, parseBranchName("their-feature"));
  const id = forge.openPr("carol", parseBranchName("their-feature"), parseBranchName("main"), "Their feature");
  await repo.cabaret("fetch");
  await repo.cabaret("mark", "--tip", "origin/their-feature", "their-feature.txt", "--change", "their-feature");
  forge.close(id);
  await repo.cabaret("fetch");
  await forge.setState(id, "open");
  expect((await repo.cabaret("fetch")).stdout).toBe(
    "github.com/test-org/widgets#1 was reopened; unarchived the change\n" +
      "fetched 0 comments from github.com/test-org/widgets#1\n" +
      "fetched github.com/test-org/widgets: 1 open forge change\n",
  );
  expect((await repo.cabaret("dev", "log", "their-feature")).stdout).toContain(
    '"source":{"forge":"github.com/test-org/widgets"},"action":{"kind":"set-archived","archived":false}',
  );
});

test("fetch mirrors a forge-side retarget into the change", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("sync");
  // A teammate retargets the forge change, as GitHub itself does when a
  // stacked PR's base branch merges.
  await forge.setParent(PR, parseBranchName("develop"));
  expect((await repo.cabaret("fetch")).stdout).toBe(
    "recorded github:alice as an alias\n" +
      'github.com/test-org/widgets#1 was retargeted; reparented onto "develop"\n' +
      "fetched 0 comments from github.com/test-org/widgets#1\n" +
      "fetched github.com/test-org/widgets: 1 open forge change\n",
  );
  expect((await repo.cabaret("dev", "log")).stdout).toContain(
    '"source":{"forge":"github.com/test-org/widgets"},"action":{"kind":"set-parent","parent":"develop"}',
  );
  // The retarget was observed once; fetching again re-mirrors nothing.
  expect((await repo.cabaret("fetch")).stdout).toBe(
    "fetched 0 comments from github.com/test-org/widgets#1\n" +
      "fetched github.com/test-org/widgets: 1 open forge change\n",
  );
});

test("fetch leaves an unpushed local reparent alone", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("sync");
  await repo.git("branch", "develop", "main");
  await repo.cabaret("reparent", "gadget", "develop");
  // The forge still shows the parent the sync left, which is not a retarget.
  expect((await repo.cabaret("fetch")).stdout).toBe(
    "recorded github:alice as an alias\n" +
      "fetched 0 comments from github.com/test-org/widgets#1\n" +
      "fetched github.com/test-org/widgets: 1 open forge change\n",
  );
  const log = (await repo.cabaret("dev", "log")).stdout.trimEnd().split("\n");
  expect(log[log.length - 1]).toContain('"action":{"kind":"set-parent","parent":"develop"}');
});

test("sync retargets the forge change's parent after a reparent", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await addChange(repo, "widget");
  await repo.cabaret("sync");
  expect((await forge.getChange(PR)).parent).toBe("gadget");
  await repo.cabaret("reparent", "widget", "main");
  await repo.cabaret("sync");
  expect((await forge.getChange(PR)).parent).toBe("main");
});

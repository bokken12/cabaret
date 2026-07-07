import { forgeRequestId, parseCommitHash, parseRefName } from "cabaret-core";
import { expect, test } from "vitest";
import { FakeForge } from "./fake-forge.js";
import { addChange, makeRepo } from "./fixture.js";

const REQUEST = forgeRequestId(1);

test("gh push pushes the branch, opens a PR on the parent, and posts comments with markers", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("comments", "add", "ship it");
  expect(await repo.cabaret("gh", "push")).toEqual({
    stdout: "opened github.com/test-org/widgets#1\npushed 1 comment to github.com/test-org/widgets#1\n",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.git("ls-remote", "--heads", "origin", "gadget")).toContain("refs/heads/gadget");
  expect(await forge.getRequest(REQUEST)).toEqual({
    id: REQUEST,
    head: "gadget",
    base: "main",
    title: "gadget",
    author: "alice@users.noreply.github.com",
    state: "open",
    changedFiles: 1,
  });
  const posted = await forge.listComments(REQUEST);
  expect(posted.map(({ body }) => body)).toEqual([expect.stringMatching(/^ship it\n\n<!-- cabaret:[0-9a-f]{64} -->$/)]);
  expect((await repo.cabaret("log")).stdout).toContain(
    '"action":{"kind":"set-forge","forge":"github.com/test-org/widgets","request":1}',
  );
});

test("gh push again is a no-op", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("comments", "add", "ship it");
  await repo.cabaret("gh", "push");
  expect(await repo.cabaret("gh", "push")).toEqual({
    stdout: "pushed 0 comments to github.com/test-org/widgets#1\n",
    stderr: "",
    exitCode: 0,
  });
  expect(await forge.listComments(REQUEST)).toHaveLength(1);
});

test("gh push attributes another user's comment to its author", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.git("config", "user.email", "bob@example.com");
  await repo.cabaret("comments", "add", "one nit");
  await repo.git("config", "user.email", "alice@example.com");
  await repo.cabaret("gh", "push");
  const posted = await forge.listComments(REQUEST);
  expect(posted.map(({ body }) => body)).toEqual([
    expect.stringMatching(/^\*\*bob@example\.com:\*\*\n\none nit\n\n<!-- cabaret:[0-9a-f]{64} -->$/),
  ]);
});

test("gh pull imports comments under forge identities, and again is a no-op", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("gh", "push");
  forge.comment(REQUEST, "carol", "does this handle empty diffs?");
  expect(await repo.cabaret("gh", "pull")).toEqual({
    stdout: "pulled 1 comment from github.com/test-org/widgets#1\n",
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("comments", "show")).stdout).toBe(
    "2025-06-15T15:06:40.000Z carol@users.noreply.github.com\n  does this handle empty diffs?\n",
  );
  expect(await repo.cabaret("gh", "pull")).toEqual({
    stdout: "pulled 0 comments from github.com/test-org/widgets#1\n",
    stderr: "",
    exitCode: 0,
  });
});

test("gh pull imports a forge-side edit as a new version, displayed once", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("gh", "push");
  const commentId = forge.comment(REQUEST, "carol", "looks wrong");
  await repo.cabaret("gh", "pull");
  forge.edit(REQUEST, commentId, "looks wrong (never mind)");
  expect((await repo.cabaret("gh", "pull")).stdout).toBe("pulled 1 comment from github.com/test-org/widgets#1\n");
  expect((await repo.cabaret("comments", "show")).stdout).toBe(
    "2025-06-15T15:06:40.001Z carol@users.noreply.github.com\n  looks wrong (never mind)\n",
  );
});

test("gh pull does not echo comments gh push posted", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.git("config", "user.email", "bob@example.com");
  await repo.cabaret("comments", "add", "one nit");
  await repo.git("config", "user.email", "alice@example.com");
  await repo.cabaret("comments", "add", "ship it");
  await repo.cabaret("gh", "push");
  expect((await repo.cabaret("gh", "pull")).stdout).toBe("pulled 0 comments from github.com/test-org/widgets#1\n");
  expect((await repo.cabaret("comments", "show")).stdout).toBe(
    "2025-05-23T11:33:20.003Z bob@example.com\n  one nit\n\n2025-05-23T11:33:20.004Z alice@example.com\n  ship it\n",
  );
});

test("gh pull records a merged PR as landing the change, once", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("gh", "push");
  const merge = parseCommitHash(await repo.git("rev-parse", "main"));
  forge.merge(REQUEST, merge);
  expect(await repo.cabaret("gh", "pull")).toEqual({
    stdout:
      "github.com/test-org/widgets#1 was merged; recorded the land\n" +
      "pulled 0 comments from github.com/test-org/widgets#1\n",
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("log")).stdout).toContain(`"action":{"kind":"land","merge":"${merge}"}`);
  expect((await repo.cabaret("gh", "pull")).stdout).toBe("pulled 0 comments from github.com/test-org/widgets#1\n");
});

test("gh pull adopts the branch's open PR when the log names none", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await forge.createRequest(parseRefName("gadget"), parseRefName("main"), "gadget");
  forge.comment(REQUEST, "carol", "opened this by hand");
  expect((await repo.cabaret("gh", "pull")).stdout).toBe("pulled 1 comment from github.com/test-org/widgets#1\n");
  expect((await repo.cabaret("log")).stdout).toContain(
    '"action":{"kind":"set-forge","forge":"github.com/test-org/widgets","request":1}',
  );
});

test("gh pull fails when there is no PR", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  expect(await repo.cabaret("gh", "pull")).toEqual({
    stdout: "",
    stderr: 'no pull request for "gadget" on github.com/test-org/widgets; run `cabaret gh push` first\n',
    exitCode: 1,
  });
});

test("gh push does not record forge activity, even an observed merge", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await repo.cabaret("gh", "push");
  forge.merge(REQUEST, parseCommitHash(await repo.git("rev-parse", "main")));
  expect(await repo.cabaret("gh", "push")).toEqual({
    stdout: "pushed 0 comments to github.com/test-org/widgets#1\n",
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("log")).stdout).not.toContain('"kind":"land"');
});

test("gh import turns a teammate's PR into a change to review", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  // The teammate's branch exists on origin and in a PR, but not locally.
  await repo.git("checkout", "-qb", "their-feature");
  await repo.write("their.txt", "their work\n");
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", "their work");
  await repo.git("push", "-q", "origin", "their-feature");
  const theirTip = await repo.git("rev-parse", "their-feature");
  await repo.git("checkout", "-q", "main");
  await repo.git("branch", "-qD", "their-feature");
  const id = forge.openRequest("carol", parseRefName("their-feature"), parseRefName("main"), "Their feature");
  forge.comment(id, "carol", "please take a look");
  expect(await repo.cabaret("gh", "import", "1")).toEqual({
    stdout: 'imported github.com/test-org/widgets#1 as "their-feature" with 1 comment\n',
    stderr: "",
    exitCode: 0,
  });
  // The branch is local again, and the change belongs to its author.
  expect(await repo.git("rev-parse", "--verify", "their-feature")).toBe(theirTip);
  expect((await repo.cabaret("owner", "show", "their-feature")).stdout).toBe("carol@users.noreply.github.com\n");
  expect((await repo.cabaret("comments", "show", "their-feature")).stdout).toBe(
    "2025-06-15T15:06:40.000Z carol@users.noreply.github.com\n  please take a look\n",
  );
  const log = (await repo.cabaret("log", "their-feature")).stdout;
  expect(log).toContain('"action":{"kind":"set-parent","parent":"main"}');
  expect(log).toContain('"action":{"kind":"set-forge","forge":"github.com/test-org/widgets","request":1}');
  // Importing again refuses rather than doubling the change.
  expect(await repo.cabaret("gh", "import", "1")).toEqual({
    stdout: "",
    stderr: 'change already exists: "their-feature"; run `cabaret gh pull` to sync it\n',
    exitCode: 1,
  });
});

test("gh import adopts the PR of an existing local branch without fetching it", async () => {
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
  forge.openRequest("alice", parseRefName("my-feature"), parseRefName("main"), "My feature");
  expect(await repo.cabaret("gh", "import", "1")).toEqual({
    stdout: 'imported github.com/test-org/widgets#1 as "my-feature" with 0 comments\n',
    stderr: "",
    exitCode: 0,
  });
  expect((await repo.cabaret("owner", "show", "my-feature")).stdout).toBe("alice@users.noreply.github.com\n");
});

test("gh push retargets the PR base after a reparent", async () => {
  const forge = new FakeForge();
  const repo = await makeRepo(forge);
  await addChange(repo, "gadget");
  await addChange(repo, "widget");
  await repo.cabaret("gh", "push");
  expect((await forge.getRequest(REQUEST)).base).toBe("gadget");
  await repo.cabaret("reparent", "widget", "main");
  await repo.cabaret("gh", "push");
  expect((await forge.getRequest(REQUEST)).base).toBe("main");
});

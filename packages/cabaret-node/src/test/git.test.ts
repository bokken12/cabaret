import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type Config,
  changeBase,
  changeTip,
  checkoutChange,
  createChange,
  DirtyWorkspaceError,
  gotoChange,
  gotoOffer,
  type LogAction,
  type LogEntry,
  parseBranchName,
  parseCommitHash,
  parseFilePath,
  timestampMs,
  userName,
  type WorkspaceStyle,
} from "cabaret-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { GitBackend } from "../index.js";

const execFileAsync = promisify(execFile);

// The backend shells out to git with this process's environment, so isolation
// from the host's git config must live there too, not in per-call overrides —
// as must the identity commits need, reaching every repo these tests create.
process.env.GIT_CONFIG_GLOBAL = devNull;
process.env.GIT_CONFIG_SYSTEM = devNull;
process.env.GIT_AUTHOR_NAME = "test";
process.env.GIT_AUTHOR_EMAIL = "test@example.com";
process.env.GIT_COMMITTER_NAME = "test";
process.env.GIT_COMMITTER_EMAIL = "test@example.com";

let repo: string;

async function git(...args: string[]): Promise<string> {
  return gitIn(repo, ...args);
}

async function gitIn(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trimEnd();
}

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "cabaret-node-test-"));
  await git("init", "-q");
  await git("commit", "-qm", "root", "--allow-empty");
  await git("checkout", "-q", "-b", "feature");
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

test("reports the current working branch", async () => {
  const backend = await GitBackend.open(repo);
  expect(await backend.currentChange()).toBe("feature");
});

test("resolveFile maps user paths to repo-relative ones", async () => {
  await mkdir(join(repo, "sub"), { recursive: true });
  const root = await GitBackend.open(repo);
  expect(root.resolveFile("src/a.ts")).toBe("src/a.ts");
  expect(root.resolveFile(join(root.root, "src/a.ts"))).toBe("src/a.ts");
  expect(() => root.resolveFile("../escape.ts")).toThrow('path is outside the repository: "../escape.ts"');
  expect(() => root.resolveFile("")).toThrow('not a valid file path: ""');
  const sub = await GitBackend.open(join(repo, "sub"));
  expect(sub.resolveFile("a.ts")).toBe("sub/a.ts");
  expect(sub.resolveFile("../src/a.ts")).toBe("src/a.ts");
  expect(sub.resolveFile(join(sub.root, "src/a.ts"))).toBe("src/a.ts");
  expect(() => sub.resolveFile("../../escape.ts")).toThrow('path is outside the repository: "../../escape.ts"');
});

test("configAll reads every value of a multi-valued key, in order", async () => {
  const backend = await GitBackend.open(repo);
  expect(await backend.configAll("cabaret.alias")).toEqual([]);
  await git("config", "--add", "cabaret.alias", "agent@example.com");
  await git("config", "--add", "cabaret.alias", "alice@work.example");
  expect(await backend.configAll("cabaret.alias")).toEqual(["agent@example.com", "alice@work.example"]);
  await git("config", "--unset-all", "cabaret.alias");
});

test("config writes: set replaces, add appends, unset removes and reports", async () => {
  const backend = await GitBackend.open(repo);
  await backend.configSet("cabaret.landMethod", "squash", "local");
  await backend.configSet("cabaret.landMethod", "merge", "local");
  expect(await backend.config("cabaret.landMethod")).toBe("merge");
  expect(await backend.configUnset("cabaret.landMethod", "local")).toBe(true);
  expect(await backend.config("cabaret.landMethod")).toBe(undefined);
  expect(await backend.configUnset("cabaret.landMethod", "local")).toBe(false);
  await backend.configAdd("cabaret.alias", "agent@example.com", "local");
  await backend.configAdd("cabaret.alias", "alice@work.example", "local");
  expect(await backend.configAll("cabaret.alias")).toEqual(["agent@example.com", "alice@work.example"]);
  expect(await backend.configUnset("cabaret.alias", "local", "agent@example.com")).toBe(true);
  expect(await backend.configAll("cabaret.alias")).toEqual(["alice@work.example"]);
  expect(await backend.configUnset("cabaret.alias", "local", "agent@example.com")).toBe(false);
  expect(await backend.configUnset("cabaret.alias", "local")).toBe(true);
});

test("a change with no log ref has the empty log", async () => {
  const backend = await GitBackend.open(repo);
  expect(await backend.readLog(parseBranchName("no-log-yet"))).toEqual([]);
});

test("readLog parses the log file into entries", async () => {
  const content =
    '{"timestamp":1748000000000,"user":"alice@example.com","action":{"kind":"set-parent","parent":"main"}}\n' +
    '{"timestamp":1748000060000,"user":"bob@example.com","action":{"kind":"set-parent","parent":"trunk"}}\n';
  await writeFile(join(repo, "log"), content);
  await git("add", "log");
  const tree = await git("write-tree");
  const commit = await git("commit-tree", tree, "-m", "cabaret log");
  await git("update-ref", "refs/cabaret/log/feature", commit);

  const backend = await GitBackend.open(repo);
  expect(await backend.readLog(parseBranchName("feature"))).toEqual([
    { timestamp: 1748000000000, user: "alice@example.com", action: { kind: "set-parent", parent: "main" } },
    { timestamp: 1748000060000, user: "bob@example.com", action: { kind: "set-parent", parent: "trunk" } },
  ]);
});

test("fails fast on a log ref whose tree lacks the log file", async () => {
  const root = await git("rev-list", "--max-parents=0", "HEAD");
  await git("update-ref", "refs/cabaret/log/malformed", root);

  const backend = await GitBackend.open(repo);
  await expect(backend.readLog(parseBranchName("malformed"))).rejects.toThrow(
    "log ref has no log file: refs/cabaret/log/malformed",
  );
});

test("changeBase is the last revision shared with the change's parent", async () => {
  const backend = await GitBackend.open(repo);
  const root = await git("rev-list", "--max-parents=0", "HEAD");
  const tree = await git("rev-parse", `${root}^{tree}`);
  // gadget and trunk each advance one commit past their shared root.
  const gadget = await git("commit-tree", tree, "-p", root, "-m", "gadget work");
  await git("update-ref", "refs/heads/gadget", gadget);
  const trunk = await git("commit-tree", tree, "-p", root, "-m", "trunk work");
  await git("update-ref", "refs/heads/trunk", trunk);
  await backend.appendLog(parseBranchName("gadget"), [
    {
      timestamp: timestampMs(1748000000000),
      user: userName("alice@example.com"),
      action: { kind: "set-parent", parent: parseBranchName("trunk") },
    },
    {
      timestamp: timestampMs(1748000000001),
      user: userName("alice@example.com"),
      action: { kind: "set-base", base: parseCommitHash(root) },
    },
  ]);
  const entries = await backend.readLog(parseBranchName("gadget"));
  expect(await changeBase(backend, parseBranchName("gadget"), entries)).toBe(root);
});

/**
 * Create a commit with the root commit's tree atop `parents` (the root commit
 * itself if none given), without touching any ref.
 */
async function plumbCommit(message: string, ...parents: string[]): Promise<string> {
  const root = await git("rev-list", "--max-parents=0", "HEAD");
  const tree = await git("rev-parse", `${root}^{tree}`);
  const atop = parents.length === 0 ? [root] : parents;
  return git("commit-tree", tree, ...atop.flatMap((p) => ["-p", p]), "-m", message);
}

function logEntry(timestamp: number, action: LogAction): LogEntry {
  return { timestamp: timestampMs(timestamp), user: userName("alice@example.com"), action };
}

/** Point branch `change` (created at `tip`) at parent branch `parent` with stored base `base`. */
async function plumbChange(change: string, tip: string, parent: string, base: string): Promise<void> {
  await git("update-ref", `refs/heads/${change}`, tip);
  const backend = await GitBackend.open(repo);
  await backend.appendLog(parseBranchName(change), [
    logEntry(1748000000000, { kind: "set-parent", parent: parseBranchName(parent) }),
    logEntry(1748000000001, { kind: "set-base", base: parseCommitHash(base) }),
  ]);
}

async function changeBaseOf(change: string): Promise<string> {
  const backend = await GitBackend.open(repo);
  return changeBase(backend, parseBranchName(change), await backend.readLog(parseBranchName(change)));
}

test("changeBase keeps the stored base when the parent was rewritten", async () => {
  const oldParent = await plumbCommit("parent work");
  const child = await plumbCommit("child work", oldParent);
  const newParent = await plumbCommit("parent work, amended");
  await git("update-ref", "refs/heads/parent-rewritten", newParent);
  await plumbChange("child-of-rewritten", child, "parent-rewritten", oldParent);
  expect(await changeBaseOf("child-of-rewritten")).toBe(oldParent);
});

test("changeBase discards a stored base the change was rebased away from", async () => {
  const oldParent = await plumbCommit("old parent work");
  const newParent = await plumbCommit("new parent work");
  const child = await plumbCommit("child work, rebuilt", newParent);
  await git("update-ref", "refs/heads/parent-adopted", newParent);
  await plumbChange("child-rebased-away", child, "parent-adopted", oldParent);
  expect(await changeBaseOf("child-rebased-away")).toBe(newParent);
});

test("changeBase prefers the merge-base when the change advanced past the stored base", async () => {
  const oldParent = await plumbCommit("parent work 1");
  const newParent = await plumbCommit("parent work 2", oldParent);
  const child = await plumbCommit("child work, advanced", newParent);
  await git("update-ref", "refs/heads/parent-advanced", newParent);
  await plumbChange("child-advanced", child, "parent-advanced", oldParent);
  expect(await changeBaseOf("child-advanced")).toBe(newParent);
});

test("changeBase prefers origin's fresher reading of a stale local parent", async () => {
  const fork = await plumbCommit("shared history");
  const landed = await plumbCommit("landed feature", fork);
  const child = await plumbCommit("child work atop the landed feature", landed);
  await git("update-ref", "refs/heads/parent-lagging", fork);
  await git("update-ref", "refs/remotes/origin/parent-lagging", landed);
  // The stored base was rebased away, so only the parent readings compete.
  const abandoned = await plumbCommit("abandoned line");
  await plumbChange("child-fresh-origin", child, "parent-lagging", abandoned);
  expect(await changeBaseOf("child-fresh-origin")).toBe(landed);
});

test("changeBase arbitrates diverged parent readings by the change's own ancestry", async () => {
  const fork = await plumbCommit("fork point");
  const originSide = await plumbCommit("landed on origin", fork);
  const localSide = await plumbCommit("stray local commit", fork);
  await git("update-ref", "refs/heads/parent-diverged", localSide);
  await git("update-ref", "refs/remotes/origin/parent-diverged", originSide);
  const onOrigin = await plumbCommit("child on origin's line", originSide);
  await plumbChange("child-on-origin-line", onOrigin, "parent-diverged", fork);
  expect(await changeBaseOf("child-on-origin-line")).toBe(originSide);
  const onLocal = await plumbCommit("child on the local line", localSide);
  await plumbChange("child-on-local-line", onLocal, "parent-diverged", fork);
  expect(await changeBaseOf("child-on-local-line")).toBe(localSide);
});

test("changeBase reads a parent that exists only on origin", async () => {
  const parent = await plumbCommit("origin-only parent work");
  const child = await plumbCommit("child of origin-only parent", parent);
  await git("update-ref", "refs/remotes/origin/parent-origin-only", parent);
  await plumbChange("child-origin-only", child, "parent-origin-only", parent);
  expect(await changeBaseOf("child-origin-only")).toBe(parent);
});

test("changeBase fails when the stored base and merge-base are unrelated", async () => {
  const side = await plumbCommit("side work");
  const parent = await plumbCommit("parent-side work");
  const child = await plumbCommit("merge of side and parent", side, parent);
  await git("update-ref", "refs/heads/parent-merged", parent);
  await plumbChange("child-merged", child, "parent-merged", side);
  await expect(changeBaseOf("child-merged")).rejects.toThrow('base of "child-merged" is ambiguous');
});

/** Record `change` as landed by `merge`, optionally at a squash-recorded tip. */
async function plumbLand(change: string, merge: string, tip?: string): Promise<void> {
  const backend = await GitBackend.open(repo);
  await backend.appendLog(parseBranchName(change), [
    logEntry(1748000000002, {
      kind: "land",
      merge: parseCommitHash(merge),
      ...(tip === undefined ? {} : { tip: parseCommitHash(tip) }),
    }),
  ]);
}

test("changeBase of a landed change derives from the land merge when the stored base is absent", async () => {
  const onto = await plumbCommit("parent at land");
  const tip = await plumbCommit("landed child work", onto);
  const merge = await plumbCommit("Land landed-child", onto, tip);
  await plumbChange("landed-child", tip, "trunk-gone", "deadbeef".repeat(5));
  await plumbLand("landed-child", merge);
  expect(await changeBaseOf("landed-child")).toBe(onto);
});

test("changeBase of a landed change keeps a stored base the landed-onto history cannot see", async () => {
  // The change was built on a parent line later rewritten: its stored base is
  // an ancestor of its tip but not of what it landed onto, and reaches deeper
  // than the merge-base with the landed-onto history.
  const oldParent = await plumbCommit("old parent line");
  const tip = await plumbCommit("child atop the old line", oldParent);
  const onto = await plumbCommit("rewritten parent line");
  const merge = await plumbCommit("Land child-of-old-line", onto, tip);
  await plumbChange("child-of-old-line", tip, "trunk-rewritten", oldParent);
  await plumbLand("child-of-old-line", merge);
  expect(await changeBaseOf("child-of-old-line")).toBe(oldParent);
});

test("changeBase of a squash-landed change falls back to the stored base when the merge is absent", async () => {
  const base = await plumbCommit("parent at squash");
  const tip = await plumbCommit("squashed child work", base);
  await plumbChange("squashed-child", tip, "trunk-squash", base);
  await plumbLand("squashed-child", "cafe".repeat(10), tip);
  expect(await changeBaseOf("squashed-child")).toBe(base);
});

test("changeBase of a squash-landed change fails when the merge and the stored base are both absent", async () => {
  const tip = await plumbCommit("squashed work, unplaceable");
  await plumbChange("squashed-unplaceable", tip, "trunk-squash-gone", "deadbeef".repeat(5));
  await plumbLand("squashed-unplaceable", "cafe".repeat(10), tip);
  await expect(changeBaseOf("squashed-unplaceable")).rejects.toThrow(
    `land merge of "squashed-unplaceable" is not in this clone: ${"cafe".repeat(10)}; run \`cabaret fetch\``,
  );
});

test("changeTip fails when the land merge is absent from the clone", async () => {
  const backend = await GitBackend.open(repo);
  const entries = [logEntry(1748000000000, { kind: "land", merge: parseCommitHash("beef".repeat(10)) })];
  await expect(changeTip(backend, parseBranchName("ghost-merge"), entries)).rejects.toThrow(
    `land merge of "ghost-merge" is not in this clone: ${"beef".repeat(10)}; run \`cabaret fetch\``,
  );
});

test("changeTip fails when a squash-recorded tip is absent from the clone", async () => {
  const backend = await GitBackend.open(repo);
  const merge = await plumbCommit("squash land whose reviewed tip is gone");
  const entries = [
    logEntry(1748000000000, {
      kind: "land",
      merge: parseCommitHash(merge),
      tip: parseCommitHash("feed".repeat(10)),
    }),
  ];
  await expect(changeTip(backend, parseBranchName("ghost-tip"), entries)).rejects.toThrow(
    `landed tip of "ghost-tip" is not in this clone: ${"feed".repeat(10)}`,
  );
});

test("landMerges surveys the newest commits, oldest first, noting a longer chain", async () => {
  const backend = await GitBackend.open(repo);
  // A first-parent chain atop the root: work, a land, more work, another land.
  const work = await plumbCommit("recent work");
  const first = await plumbCommit("Land first-recent\n\nCabaret-Landed: first-recent", work);
  const more = await plumbCommit("more recent work", first);
  const second = await plumbCommit("Land second-recent\n\nCabaret-Landed: second-recent", more);
  const tip = parseCommitHash(second);
  // A scan wide enough for the whole chain (tip, more, first, work, root) sees
  // both lands and no further history.
  expect(await backend.landMerges(undefined, tip, 5)).toEqual({
    lands: [
      { change: "first-recent", commit: first, onto: work },
      { change: "second-recent", commit: second, onto: more },
    ],
    more: false,
  });
  // A scan of the newest three commits reaches back only to the first land,
  // and notes the chain continuing past it.
  expect(await backend.landMerges(undefined, tip, 3)).toEqual({
    lands: [
      { change: "first-recent", commit: first, onto: work },
      { change: "second-recent", commit: second, onto: more },
    ],
    more: true,
  });
  expect(await backend.landMerges(undefined, tip, 1)).toEqual({
    lands: [{ change: "second-recent", commit: second, onto: more }],
    more: true,
  });
  // A base stops the walk where the change's history ends: the same window
  // that continued past three commits is exhausted once `work` bounds it.
  expect(await backend.landMerges(parseCommitHash(work), tip, 3)).toEqual({
    lands: [
      { change: "first-recent", commit: first, onto: work },
      { change: "second-recent", commit: second, onto: more },
    ],
    more: false,
  });
  expect(await backend.landMerges(parseCommitHash(work), tip, 2)).toEqual({
    lands: [{ change: "second-recent", commit: second, onto: more }],
    more: true,
  });
});

test("isAncestor distinguishes ancestors from unrelated commits", async () => {
  const backend = await GitBackend.open(repo);
  const rootHash = parseCommitHash(await git("rev-list", "--max-parents=0", "HEAD"));
  const onto = parseCommitHash(await plumbCommit("ancestry a"));
  const other = parseCommitHash(await plumbCommit("ancestry b"));
  expect(await backend.isAncestor(rootHash, onto)).toBe(true);
  expect(await backend.isAncestor(onto, rootHash)).toBe(false);
  expect(await backend.isAncestor(onto, other)).toBe(false);
  expect(await backend.isAncestor(onto, onto)).toBe(true);
});

test("same-revision ancestry answers without consulting the repository", async () => {
  const backend = await GitBackend.open(repo);
  const absent = parseCommitHash("deadbeef".repeat(5));
  expect(await backend.isAncestor(absent, absent)).toBe(true);
  expect(await backend.mergeBase(absent, absent)).toBe(absent);
});

test("tip is the branch's commit, or undefined for a missing branch", async () => {
  const backend = await GitBackend.open(repo);
  expect(await backend.tip(parseBranchName("feature"))).toBe(await git("rev-parse", "refs/heads/feature"));
  expect(await backend.tip(parseBranchName("no-such-branch"))).toBeUndefined();
});

test("create creates at the given commit and refuses to overwrite", async () => {
  const backend = await GitBackend.open(repo);
  const tip = parseCommitHash(await plumbCommit("branch target"));
  await backend.create(parseBranchName("created"), tip);
  expect(await git("rev-parse", "refs/heads/created")).toBe(tip);
  await expect(backend.create(parseBranchName("created"), tip)).rejects.toThrow(/git update-ref/);
});

test("advance fast-forwards to a descendant and refuses anything else", async () => {
  const backend = await GitBackend.open(repo);
  const start = parseCommitHash(await plumbCommit("advance start"));
  const next = parseCommitHash(await plumbCommit("advance next", start));
  const stray = parseCommitHash(await plumbCommit("advance stray", start));
  await backend.create(parseBranchName("advancing"), start);
  await backend.advance(parseBranchName("advancing"), next);
  expect(await git("rev-parse", "refs/heads/advancing")).toBe(next);
  // Already there: nothing to move.
  await backend.advance(parseBranchName("advancing"), next);
  expect(await git("rev-parse", "refs/heads/advancing")).toBe(next);
  // A sibling does not descend from the tip, so moving there would drop work.
  await expect(backend.advance(parseBranchName("advancing"), stray)).rejects.toThrow(
    `cannot advance "advancing": ${stray} does not descend from its tip ${next}`,
  );
  expect(await git("rev-parse", "refs/heads/advancing")).toBe(next);
});

test("changeBase fails on a change that does not exist", async () => {
  const backend = await GitBackend.open(repo);
  await expect(changeBase(backend, parseBranchName("orphan"), [])).rejects.toThrow('change does not exist: "orphan"');
});

test("rename moves nothing when its transaction fails", async () => {
  const backend = await GitBackend.open(repo);
  const tip = parseCommitHash(await plumbCommit("rename source work"));
  await git("update-ref", "refs/heads/rename-src", tip);
  await backend.appendLog(parseBranchName("rename-src"), [
    logEntry(1748000000000, { kind: "set-parent", parent: parseBranchName("feature") }),
  ]);
  const logTip = await git("rev-parse", "refs/cabaret/log/rename-src");
  await git("update-ref", "refs/heads/rename-taken", tip);
  await git("checkout", "-q", "rename-src");
  await expect(backend.rename(parseBranchName("rename-src"), parseBranchName("rename-taken"))).rejects.toThrow(
    /reference already exists/,
  );
  // The failed transaction moved nothing, and HEAD is re-attached to the source.
  expect(await git("symbolic-ref", "HEAD")).toBe("refs/heads/rename-src");
  expect(await git("rev-parse", "refs/heads/rename-src")).toBe(tip);
  expect(await git("rev-parse", "refs/cabaret/log/rename-src")).toBe(logTip);
  await expect(git("rev-parse", "--verify", "refs/cabaret/log/rename-taken")).rejects.toThrow();
  await git("checkout", "-q", "feature");
});

test("rename refuses a branch checked out in another worktree", async () => {
  const backend = await GitBackend.open(repo);
  const tip = parseCommitHash(await plumbCommit("worktree work"));
  await git("update-ref", "refs/heads/wt-src", tip);
  await backend.appendLog(parseBranchName("wt-src"), [
    logEntry(1748000000000, { kind: "set-parent", parent: parseBranchName("feature") }),
  ]);
  const linked = join(repo, "linked-worktree");
  await git("worktree", "add", linked, "wt-src");
  await expect(backend.rename(parseBranchName("wt-src"), parseBranchName("wt-dst"))).rejects.toThrow(
    'branch is checked out in another worktree: "wt-src"',
  );
  expect(await backend.tip(parseBranchName("wt-src"))).toBe(tip);
  expect(await backend.tip(parseBranchName("wt-dst"))).toBeUndefined();
  await git("worktree", "remove", linked);
});

/** A bare origin holding branches `main` and `extra`, and an empty repo with it as `origin`. */
async function makeRemotePair(): Promise<{ dir: string; origin: string }> {
  const origin = await mkdtemp(join(tmpdir(), "cabaret-node-test-origin-"));
  await execFileAsync("git", ["init", "-q", "--bare", origin]);
  const seed = await mkdtemp(join(tmpdir(), "cabaret-node-test-seed-"));
  await gitIn(seed, "init", "-qb", "main");
  await gitIn(seed, "commit", "-qm", "root", "--allow-empty");
  await gitIn(seed, "branch", "extra");
  await gitIn(seed, "push", "-q", origin, "main", "extra");
  await rm(seed, { recursive: true, force: true });
  const dir = await mkdtemp(join(tmpdir(), "cabaret-node-test-"));
  // Off `main`: git refuses to fetch into the checked-out branch.
  await gitIn(dir, "init", "-qb", "scratch");
  await gitIn(dir, "remote", "add", "origin", origin);
  return { dir, origin };
}

test("fetchOrigin refreshes origin readings without creating local branches", async () => {
  const { dir, origin } = await makeRemotePair();
  try {
    const backend = await GitBackend.open(dir);
    await backend.fetchOrigin();
    for (const branch of [parseBranchName("main"), parseBranchName("extra")]) {
      expect(await backend.originTip(branch)).toBeDefined();
      expect(await backend.tip(branch)).toBeUndefined();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(origin, { recursive: true, force: true });
  }
});

test("originFetched dates this workspace's last successful fetch", async () => {
  const { dir, origin } = await makeRemotePair();
  const worktree = `${dir}-worktree`;
  try {
    const backend = await GitBackend.open(dir);
    expect(await backend.originFetched()).toBeUndefined();
    await backend.fetchOrigin();
    const fetchedAt = new Date(5_000);
    await utimes(join(dir, ".git", "FETCH_HEAD"), fetchedAt, fetchedAt);
    expect(await backend.originFetched()).toBe(timestampMs(fetchedAt.getTime()));
    // Each workspace's reading is its own: a linked worktree starts without
    // one, and its fetch leaves the primary's reading alone.
    await gitIn(dir, "branch", "main", "refs/remotes/origin/main");
    await gitIn(dir, "worktree", "add", "-q", worktree, "main");
    const inWorktree = await GitBackend.open(worktree);
    expect(await inWorktree.originFetched()).toBeUndefined();
    await inWorktree.fetchOrigin();
    expect(await inWorktree.originFetched()).toBeDefined();
    expect(await backend.originFetched()).toBe(timestampMs(fetchedAt.getTime()));
    // A failed fetch loses the reading until the next success.
    await rm(origin, { recursive: true, force: true });
    await expect(backend.fetchOrigin()).rejects.toThrow();
    expect(await backend.originFetched()).toBeUndefined();
  } finally {
    await rm(worktree, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
    await rm(origin, { recursive: true, force: true });
  }
});

test("advanceBranches fast-forwards idle branches and clean worktrees with origin strictly ahead", async () => {
  const { dir, origin } = await makeRemotePair();
  const worktree = `${dir}-worktree`;
  try {
    const backend = await GitBackend.open(dir);
    await backend.fetchOrigin();
    const root = await gitIn(dir, "rev-parse", "refs/remotes/origin/main");
    // A commit origin never sees, to diverge with; then one origin gains,
    // touching a file so a carried working tree is observable.
    await gitIn(dir, "switch", "-qc", "tmp", root);
    await gitIn(dir, "commit", "-qm", "local only", "--allow-empty");
    const local = await gitIn(dir, "rev-parse", "HEAD");
    await gitIn(dir, "update-ref", "refs/heads/diverge", local);
    await gitIn(dir, "reset", "-q", "--hard", root);
    await writeFile(join(dir, "landed.txt"), "landed\n");
    await gitIn(dir, "add", "landed.txt");
    await gitIn(dir, "commit", "-qm", "landed on origin");
    const landed = await gitIn(dir, "rev-parse", "HEAD");
    await gitIn(dir, "push", "-q", "origin", "tmp:main", "tmp:extra", "tmp:held", "tmp:diverge");
    await gitIn(dir, "branch", "main", root);
    // Checked out here, clean, and behind: advances, the working tree following.
    await gitIn(dir, "switch", "-qc", "extra", root);
    // Checked out in a dirty worktree and behind: its line of work stays put.
    await gitIn(dir, "branch", "held", root);
    await gitIn(dir, "worktree", "add", "-q", worktree, "held");
    await writeFile(join(worktree, "wip.txt"), "wip\n");
    await backend.fetchOrigin();

    expect(await backend.advanceBranches()).toEqual([parseBranchName("extra"), parseBranchName("main")]);
    expect(await backend.tip(parseBranchName("main"))).toBe(parseCommitHash(landed));
    expect(await backend.tip(parseBranchName("extra"))).toBe(parseCommitHash(landed));
    expect(await readFile(join(dir, "landed.txt"), "utf8")).toBe("landed\n");
    expect(await backend.tip(parseBranchName("held"))).toBe(parseCommitHash(root));
    expect(await backend.tip(parseBranchName("diverge"))).toBe(parseCommitHash(local));
    // The worktree cleaned up, its branch moves like any other.
    await rm(join(worktree, "wip.txt"));
    expect(await backend.advanceBranches()).toEqual([parseBranchName("held")]);
    expect(await backend.tip(parseBranchName("held"))).toBe(parseCommitHash(landed));
    expect(await readFile(join(worktree, "landed.txt"), "utf8")).toBe("landed\n");
    // Nothing left to move: another pass is a no-op.
    expect(await backend.advanceBranches()).toEqual([]);
  } finally {
    await rm(worktree, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
    await rm(origin, { recursive: true, force: true });
  }
});

/** Checks out `main` in `dir` at origin's tip, then advances origin one commit past it. */
async function checkoutBehindOrigin(dir: string, origin: string): Promise<string> {
  await gitIn(dir, "fetch", "-q", "origin", "refs/heads/main:refs/heads/main");
  await gitIn(dir, "checkout", "-q", "main");
  const tree = await gitIn(origin, "rev-parse", "main^{tree}");
  const advanced = await gitIn(origin, "commit-tree", tree, "-p", "main", "-m", "advance");
  await gitIn(origin, "update-ref", "refs/heads/main", advanced);
  return advanced;
}

test("fetch fast-forwards the checked-out branch despite a concurrent log fetch", async () => {
  const { dir, origin } = await makeRemotePair();
  const shims = await mkdtemp(join(tmpdir(), "cabaret-node-test-shims-"));
  const realPath = process.env.PATH;
  try {
    const advanced = await checkoutBehindOrigin(dir, origin);
    // A log ref on origin: a root commit sharing no history with `main`.
    const emptyTree = await gitIn(dir, "hash-object", "-w", "-t", "tree", devNull);
    const logCommit = await gitIn(dir, "commit-tree", emptyTree, "-m", "log");
    await gitIn(dir, "push", "-q", "origin", `${logCommit}:refs/cabaret/log/x`);
    // A `git` shim replaying the race: a background log sync lands between a
    // fetch and whatever consumes its FETCH_HEAD, and command-line refspecs
    // are recorded there as for-merge even with a destination — so FETCH_HEAD
    // ends up naming the unrelated log commit as the merge candidate.
    const realGit = (await execFileAsync("sh", ["-c", "command -v git"])).stdout.trim();
    await writeFile(
      join(shims, "git"),
      `#!/bin/sh\n"${realGit}" "$@"\ncode=$?\nif [ "$1" = fetch ]; then\n` +
        `  "${realGit}" -C "${dir}" fetch --quiet origin "+refs/cabaret/log/*:refs/cabaret/remote-log/*"\nfi\nexit $code\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${shims}:${realPath}`;
    try {
      const backend = await GitBackend.open(dir);
      await backend.fetch(parseBranchName("main"));
    } finally {
      process.env.PATH = realPath;
    }
    expect(await gitIn(dir, "rev-parse", "HEAD")).toBe(advanced);
    expect(await gitIn(dir, "rev-parse", "refs/remotes/origin/main")).toBe(advanced);
    // The interleaving really happened: the log commit is FETCH_HEAD's merge candidate.
    expect(await readFile(join(dir, ".git", "FETCH_HEAD"), "utf8")).toContain(`${logCommit}\t\t`);
  } finally {
    process.env.PATH = realPath;
    await rm(shims, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
    await rm(origin, { recursive: true, force: true });
  }
});

test("fetch refuses a checked-out branch that diverged from origin", async () => {
  const { dir, origin } = await makeRemotePair();
  try {
    const advanced = await checkoutBehindOrigin(dir, origin);
    await gitIn(dir, "commit", "-qm", "local", "--allow-empty");
    const local = await gitIn(dir, "rev-parse", "HEAD");
    const backend = await GitBackend.open(dir);
    await expect(backend.fetch(parseBranchName("main"))).rejects.toThrow(/fast-forward/);
    expect(await gitIn(dir, "rev-parse", "main")).toBe(local);
    expect(await gitIn(dir, "rev-parse", "refs/remotes/origin/main")).toBe(advanced);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(origin, { recursive: true, force: true });
  }
});

test("fetch refuses an idle branch that diverged from origin", async () => {
  const { dir, origin } = await makeRemotePair();
  try {
    await gitIn(dir, "fetch", "-q", "origin", "refs/heads/main:refs/heads/main");
    const tree = await gitIn(origin, "rev-parse", "main^{tree}");
    await gitIn(
      origin,
      "update-ref",
      "refs/heads/main",
      await gitIn(origin, "commit-tree", tree, "-p", "main", "-m", "remote"),
    );
    const local = await gitIn(dir, "commit-tree", tree, "-p", "main", "-m", "local");
    await gitIn(dir, "update-ref", "refs/heads/main", local);
    const backend = await GitBackend.open(dir);
    // `--quiet` swallows git's per-ref "[rejected]" detail; the failure
    // surfaces as the fetch command itself failing.
    await expect(backend.fetch(parseBranchName("main"))).rejects.toThrow(
      "Command failed: git fetch --quiet origin refs/heads/main:refs/heads/main",
    );
    expect(await gitIn(dir, "rev-parse", "main")).toBe(local);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(origin, { recursive: true, force: true });
  }
});

test("deleteLog deletes the log locally and on origin, tolerating a repeat", async () => {
  const { dir, origin } = await makeRemotePair();
  try {
    const backend = await GitBackend.open(dir);
    await gitIn(dir, "commit", "-qm", "root", "--allow-empty");
    await backend.appendLog(parseBranchName("widgets"), [
      logEntry(1748000000000, { kind: "set-parent", parent: parseBranchName("main") }),
    ]);
    await backend.syncLog(parseBranchName("widgets"));
    expect(await gitIn(origin, "for-each-ref", "refs/cabaret/")).not.toBe("");

    await backend.deleteLog(parseBranchName("widgets"));
    expect(await backend.readLog(parseBranchName("widgets"))).toEqual([]);
    expect(await gitIn(dir, "for-each-ref", "refs/cabaret/")).toBe("");
    expect(await gitIn(origin, "for-each-ref", "refs/cabaret/")).toBe("");
    // Origin already lacks the ref, as after a concurrent prune: not a failure.
    await backend.deleteLog(parseBranchName("widgets"));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(origin, { recursive: true, force: true });
  }
});

test("listChanges names every change with a log, sorted by name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cabaret-node-test-"));
  try {
    await gitIn(dir, "init", "-q");
    await gitIn(dir, "commit", "-qm", "root", "--allow-empty");
    const backend = await GitBackend.open(dir);
    expect(await backend.listChanges()).toEqual([]);
    for (const change of ["widgets", "team/api", "docs"]) {
      await backend.appendLog(parseBranchName(change), [
        logEntry(1748000000000, { kind: "set-parent", parent: parseBranchName("main") }),
      ]);
    }
    expect(await backend.listChanges()).toEqual(["docs", "team/api", "widgets"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Commit `files` (path → content) on top of the root commit, returning the commit hash. */
async function plumbTree(files: Record<string, string>): Promise<string> {
  await git("read-tree", "--empty");
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(repo, "blob-scratch"), content);
    const blob = await git("hash-object", "-w", "--", join(repo, "blob-scratch"));
    await git("update-index", "--add", "--cacheinfo", `100644,${blob},${path}`);
  }
  const tree = await git("write-tree");
  return git("commit-tree", tree, "-m", "tree fixture");
}

test("changedFiles pairs moved files with their old paths", async () => {
  const backend = await GitBackend.open(repo);
  const guide = `opening thoughts\n${"a steady middle line\n".repeat(30)}closing thoughts\n`;
  const notes = `first entry\n${"another ordinary entry\n".repeat(30)}last entry\n`;
  const prev = parseCommitHash(
    await plumbTree({
      "kept.txt": "kept\n",
      "edited.txt": "before\n",
      "moved/guide.txt": guide,
      "notes.txt": notes,
      "dropped.txt": "dropped\n",
    }),
  );
  const next = parseCommitHash(
    await plumbTree({
      "kept.txt": "kept\n",
      "edited.txt": "after\n",
      "docs/guide.txt": guide,
      "journal.txt": notes.replace("last entry", "final entry"),
      "fresh.txt": "fresh\n",
    }),
  );
  // An exact move pairs by hash and an edited one by similarity, both named
  // by their new path; everything else stays a single-path entry.
  expect(await backend.changedFiles(prev, next)).toEqual([
    { path: "docs/guide.txt", movedFrom: "moved/guide.txt" },
    { path: "dropped.txt", movedFrom: undefined },
    { path: "edited.txt", movedFrom: undefined },
    { path: "fresh.txt", movedFrom: undefined },
    { path: "journal.txt", movedFrom: "notes.txt" },
  ]);
});

test("changedFiles leaves a wholesale rewrite at a new path unpaired", async () => {
  const backend = await GitBackend.open(repo);
  const prev = parseCommitHash(await plumbTree({ "config.old": "alpha\nbeta\ngamma\n" }));
  const next = parseCommitHash(await plumbTree({ "config.new": "one\ntwo\nthree\nfour\n" }));
  expect(await backend.changedFiles(prev, next)).toEqual([
    { path: "config.new", movedFrom: undefined },
    { path: "config.old", movedFrom: undefined },
  ]);
});

test("readFile round-trips exact contents, keyed by byte-counted sizes", async () => {
  const backend = await GitBackend.open(repo);
  const files = {
    "dir with space/ün icode.txt": "naïve — 日本語 🎭 without trailing newline",
    "empty.txt": "",
    "sub/deep/one.txt": "one\n",
    // Big enough to arrive split across several pipe chunks.
    "big.txt": `${"long line of filler text\n".repeat(12000)}tail`,
  };
  const commit = parseCommitHash(await plumbTree(files));
  for (const [path, content] of Object.entries(files)) {
    expect(await backend.readFile(commit, parseFilePath(path))).toBe(content);
  }
});

test("readFile distinguishes an absent path from a directory", async () => {
  const backend = await GitBackend.open(repo);
  const commit = parseCommitHash(await plumbTree({ "sub/file.txt": "content\n" }));
  expect(await backend.readFile(commit, parseFilePath("sub/missing.txt"))).toBeUndefined();
  await expect(backend.readFile(commit, parseFilePath("sub"))).rejects.toThrow(
    `not a file: "sub" at ${commit.slice(0, 12)} is a tree`,
  );
});

test("resolveCommit rejects an unknown revision", async () => {
  const backend = await GitBackend.open(repo);
  await expect(backend.resolveCommit("no-such-revision")).rejects.toThrow('unknown revision: "no-such-revision"');
});

test("pipelined reads all frame correctly", async () => {
  const backend = await GitBackend.open(repo);
  const files = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`pipelined/file-${i}.txt`, `content of file ${i}\n`.repeat(i)]),
  );
  const commit = parseCommitHash(await plumbTree(files));
  const reads = await Promise.all([
    ...Object.keys(files).map((path) => backend.readFile(commit, parseFilePath(path))),
    ...Array.from({ length: 10 }, () => backend.tip(parseBranchName("feature"))),
  ]);
  const tip = await git("rev-parse", "refs/heads/feature");
  expect(reads).toEqual([...Object.values(files), ...Array(10).fill(tip)]);
});

test("reads see refs and objects written after the session started", async () => {
  const backend = await GitBackend.open(repo);
  expect(await backend.readLog(parseBranchName("late-arrival"))).toEqual([]);
  const entry = logEntry(1748000000000, { kind: "set-parent", parent: parseBranchName("feature") });
  await backend.appendLog(parseBranchName("late-arrival"), [entry]);
  expect(await backend.readLog(parseBranchName("late-arrival"))).toEqual([entry]);
});

test("reads recover after the session's git process dies", async () => {
  const backend = await GitBackend.open(repo);
  const tip = await git("rev-parse", "refs/heads/feature");
  expect(await backend.tip(parseBranchName("feature"))).toBe(tip);
  const { reader } = backend as unknown as {
    reader: { child?: { kill(): void; once(e: string, f: () => void): void } };
  };
  if (reader.child === undefined) {
    throw new Error("session did not spawn");
  }
  const closed = new Promise<void>((resolve) => reader.child?.once("close", () => resolve()));
  reader.child.kill();
  await closed;
  expect(await backend.tip(parseBranchName("feature"))).toBe(tip);
});

test("fails fast on detached HEAD", async () => {
  const backend = await GitBackend.open(repo);
  const head = await git("rev-parse", "HEAD");
  await git("checkout", "-q", head);
  await expect(backend.currentChange()).rejects.toThrow(
    "HEAD is detached; check out a branch or name the change explicitly",
  );
});

test("workspaces lists each working tree with its branch and dirtiness, dropping pruned ones", async () => {
  // Nested so the linked working trees live beside the repo, not inside it.
  const base = await mkdtemp(join(tmpdir(), "cabaret-workspaces-test-"));
  try {
    const dir = join(base, "repo");
    await mkdir(dir);
    await gitIn(dir, "init", "-qb", "main");
    await gitIn(dir, "commit", "-qm", "root", "--allow-empty");
    await gitIn(dir, "branch", "gadget");
    await gitIn(dir, "branch", "doomed");
    await gitIn(dir, "worktree", "add", "--quiet", join(base, "gadget-tree"), "gadget");
    await gitIn(dir, "worktree", "add", "--quiet", "--detach", join(base, "adrift-tree"));
    await gitIn(dir, "worktree", "add", "--quiet", join(base, "doomed-tree"), "doomed");
    await writeFile(join(base, "gadget-tree", "junk.txt"), "junk\n");
    await rm(join(base, "doomed-tree"), { recursive: true, force: true });
    const backend = await GitBackend.open(dir);
    // Paths as git reports them, symlinks (macOS /tmp) resolved.
    const roots = await Promise.all(
      [dir, join(base, "adrift-tree"), join(base, "gadget-tree")].map((tree) =>
        gitIn(tree, "rev-parse", "--show-toplevel"),
      ),
    );
    expect(await backend.workspaces()).toEqual([
      { path: roots[0], change: "main", dirty: false, primary: true },
      { path: roots[1], change: undefined, dirty: false, primary: false },
      { path: roots[2], change: "gadget", dirty: true, primary: false },
    ]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("gotoChange reports a change's workspace, checking one out shared or adding one dedicated", async () => {
  // Nested so a dedicated workspace lands beside the repo, not inside it.
  const base = await mkdtemp(join(tmpdir(), "cabaret-goto-test-"));
  try {
    const dir = join(base, "repo");
    await mkdir(dir);
    await gitIn(dir, "init", "-qb", "main");
    await gitIn(dir, "config", "user.email", "alice@example.com");
    await gitIn(dir, "commit", "-qm", "root", "--allow-empty");
    const backend = await GitBackend.open(dir);
    let clock = 1748000000000;
    const now = () => timestampMs(clock++);
    for (const change of ["gizmo", "widget", "gadget"]) {
      await createChange(backend, now, parseBranchName(change), parseBranchName("main"));
    }
    const config = (workspaceStyle: WorkspaceStyle): Config => ({
      landMethod: "merge",
      landVia: "auto",
      context: undefined,
      workspaceStyle,
    });
    const root = await gitIn(dir, "rev-parse", "--show-toplevel");

    // Shared style checks the change out in this working tree; thereafter
    // the tree is the change's workspace.
    expect(await gotoChange(backend, config("shared"), parseBranchName("gizmo"), false)).toEqual({
      kind: "checked-out",
      path: root,
    });
    expect(await gitIn(dir, "branch", "--show-current")).toBe("gizmo");
    expect(await gotoChange(backend, config("shared"), parseBranchName("gizmo"), false)).toEqual({
      kind: "at",
      path: root,
    });

    // A dirty tree refuses the checkout until overridden.
    await writeFile(join(dir, "junk.txt"), "junk\n");
    await expect(gotoChange(backend, config("shared"), parseBranchName("widget"), false)).rejects.toThrow(
      DirtyWorkspaceError,
    );
    expect(await gotoChange(backend, config("shared"), parseBranchName("widget"), true)).toEqual({
      kind: "checked-out",
      path: root,
    });

    // Dedicated style leaves this tree alone and adds a sibling workspace.
    expect(await gotoChange(backend, config("dedicated"), parseBranchName("gadget"), false)).toEqual({
      kind: "added",
      path: `${root}-gadget`,
    });
    expect(await gitIn(dir, "branch", "--show-current")).toBe("widget");
    expect(await gitIn(`${root}-gadget`, "branch", "--show-current")).toBe("gadget");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("gotoOffer reports a held change as here and offers ways to bring in an unheld one", async () => {
  // Nested so linked workspaces land beside the repo, not inside it.
  const base = await mkdtemp(join(tmpdir(), "cabaret-offer-test-"));
  try {
    const dir = join(base, "repo");
    await mkdir(dir);
    await gitIn(dir, "init", "-qb", "main");
    await gitIn(dir, "config", "user.email", "alice@example.com");
    await gitIn(dir, "commit", "-qm", "root", "--allow-empty");
    const backend = await GitBackend.open(dir);
    let clock = 1748000000000;
    const now = () => timestampMs(clock++);
    for (const change of ["gizmo", "widget", "gadget"]) {
      await createChange(backend, now, parseBranchName(change), parseBranchName("main"));
    }
    const config = (workspaceStyle: WorkspaceStyle): Config => ({
      landMethod: "merge",
      landVia: "auto",
      context: undefined,
      workspaceStyle,
    });
    const root = await gitIn(dir, "rev-parse", "--show-toplevel");
    await gitIn(dir, "worktree", "add", "--quiet", `${root}-gadget`, "gadget");

    // A change held elsewhere offers only its own workspace, whatever the style.
    expect(await gotoOffer(backend, config("shared"), parseBranchName("gadget"))).toEqual({
      kind: "offer",
      options: [{ kind: "open", path: `${root}-gadget` }],
    });

    // An unheld change in a clean tree offers a checkout, joined and led by a
    // dedicated workspace when the style prefers one.
    expect(await gotoOffer(backend, config("shared"), parseBranchName("gizmo"))).toEqual({
      kind: "offer",
      options: [{ kind: "checkout" }],
    });
    expect(await gotoOffer(backend, config("dedicated"), parseBranchName("gizmo"))).toEqual({
      kind: "offer",
      options: [{ kind: "add", path: `${root}-gizmo` }, { kind: "checkout" }],
    });

    // Taking the checkout makes this tree the change's home.
    expect(await checkoutChange(backend, parseBranchName("gizmo"), false)).toBe(root);
    expect(await gitIn(dir, "branch", "--show-current")).toBe("gizmo");
    expect(await gotoOffer(backend, config("shared"), parseBranchName("gizmo"))).toEqual({ kind: "here" });

    // A dirty tree rules the checkout out, leaving only a dedicated workspace.
    await writeFile(join(dir, "junk.txt"), "junk\n");
    expect(await gotoOffer(backend, config("shared"), parseBranchName("widget"))).toEqual({
      kind: "offer",
      options: [{ kind: "add", path: `${root}-widget` }],
    });
    await expect(checkoutChange(backend, parseBranchName("widget"), false)).rejects.toThrow(DirtyWorkspaceError);
    expect(await checkoutChange(backend, parseBranchName("widget"), true)).toBe(root);
    expect(await gitIn(dir, "branch", "--show-current")).toBe("widget");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

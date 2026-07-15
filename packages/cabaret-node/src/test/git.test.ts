import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  changeBase,
  type LogAction,
  type LogEntry,
  parseCommitHash,
  parseFilePath,
  parseRefName,
  timestampMs,
  userName,
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
  expect(await backend.currentBranch()).toBe("feature");
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
  expect(await backend.readLog(parseRefName("no-log-yet"))).toEqual([]);
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
  expect(await backend.readLog(parseRefName("feature"))).toEqual([
    { timestamp: 1748000000000, user: "alice@example.com", action: { kind: "set-parent", parent: "main" } },
    { timestamp: 1748000060000, user: "bob@example.com", action: { kind: "set-parent", parent: "trunk" } },
  ]);
});

test("fails fast on a log ref whose tree lacks the log file", async () => {
  const root = await git("rev-list", "--max-parents=0", "HEAD");
  await git("update-ref", "refs/cabaret/log/malformed", root);

  const backend = await GitBackend.open(repo);
  await expect(backend.readLog(parseRefName("malformed"))).rejects.toThrow(
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
  await backend.appendLog(parseRefName("gadget"), [
    {
      timestamp: timestampMs(1748000000000),
      user: userName("alice@example.com"),
      action: { kind: "set-parent", parent: parseRefName("trunk") },
    },
    {
      timestamp: timestampMs(1748000000001),
      user: userName("alice@example.com"),
      action: { kind: "set-base", base: parseCommitHash(root) },
    },
  ]);
  const entries = await backend.readLog(parseRefName("gadget"));
  expect(await changeBase(backend, parseRefName("gadget"), entries)).toBe(root);
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
  await backend.appendLog(parseRefName(change), [
    logEntry(1748000000000, { kind: "set-parent", parent: parseRefName(parent) }),
    logEntry(1748000000001, { kind: "set-base", base: parseCommitHash(base) }),
  ]);
}

async function changeBaseOf(change: string): Promise<string> {
  const backend = await GitBackend.open(repo);
  return changeBase(backend, parseRefName(change), await backend.readLog(parseRefName(change)));
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

test("branchTip is the branch's commit, or undefined for a missing branch", async () => {
  const backend = await GitBackend.open(repo);
  expect(await backend.branchTip(parseRefName("feature"))).toBe(await git("rev-parse", "refs/heads/feature"));
  expect(await backend.branchTip(parseRefName("no-such-branch"))).toBeUndefined();
});

test("createBranch creates at the given commit and refuses to overwrite", async () => {
  const backend = await GitBackend.open(repo);
  const tip = parseCommitHash(await plumbCommit("branch target"));
  await backend.createBranch(parseRefName("created"), tip);
  expect(await git("rev-parse", "refs/heads/created")).toBe(tip);
  await expect(backend.createBranch(parseRefName("created"), tip)).rejects.toThrow(/git update-ref/);
});

test("changeBase fails on a change that does not exist", async () => {
  const backend = await GitBackend.open(repo);
  await expect(changeBase(backend, parseRefName("orphan"), [])).rejects.toThrow('change does not exist: "orphan"');
});

test("renameChange moves nothing when its transaction fails", async () => {
  const backend = await GitBackend.open(repo);
  const tip = parseCommitHash(await plumbCommit("rename source work"));
  await git("update-ref", "refs/heads/rename-src", tip);
  await backend.appendLog(parseRefName("rename-src"), [
    logEntry(1748000000000, { kind: "set-parent", parent: parseRefName("feature") }),
  ]);
  const logTip = await git("rev-parse", "refs/cabaret/log/rename-src");
  await git("update-ref", "refs/heads/rename-taken", tip);
  await git("checkout", "-q", "rename-src");
  await expect(backend.renameChange(parseRefName("rename-src"), parseRefName("rename-taken"))).rejects.toThrow(
    /reference already exists/,
  );
  // The failed transaction moved nothing, and HEAD is re-attached to the source.
  expect(await git("symbolic-ref", "HEAD")).toBe("refs/heads/rename-src");
  expect(await git("rev-parse", "refs/heads/rename-src")).toBe(tip);
  expect(await git("rev-parse", "refs/cabaret/log/rename-src")).toBe(logTip);
  await expect(git("rev-parse", "--verify", "refs/cabaret/log/rename-taken")).rejects.toThrow();
  await git("checkout", "-q", "feature");
});

test("renameChange refuses a branch checked out in another worktree", async () => {
  const backend = await GitBackend.open(repo);
  const tip = parseCommitHash(await plumbCommit("worktree work"));
  await git("update-ref", "refs/heads/wt-src", tip);
  await backend.appendLog(parseRefName("wt-src"), [
    logEntry(1748000000000, { kind: "set-parent", parent: parseRefName("feature") }),
  ]);
  const linked = join(repo, "linked-worktree");
  await git("worktree", "add", linked, "wt-src");
  await expect(backend.renameChange(parseRefName("wt-src"), parseRefName("wt-dst"))).rejects.toThrow(
    'branch is checked out in another worktree: "wt-src"',
  );
  expect(await backend.branchTip(parseRefName("wt-src"))).toBe(tip);
  expect(await backend.branchTip(parseRefName("wt-dst"))).toBeUndefined();
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

test("fetchBranches fetches many branches at once", async () => {
  const { dir, origin } = await makeRemotePair();
  try {
    const backend = await GitBackend.open(dir);
    await backend.fetchBranches([parseRefName("main"), parseRefName("extra")]);
    expect(await backend.branchTip(parseRefName("main"))).toBeDefined();
    expect(await backend.branchTip(parseRefName("extra"))).toBeDefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(origin, { recursive: true, force: true });
  }
});

test("fetchBranches fetches what it can when a branch is missing on origin", async () => {
  const { dir, origin } = await makeRemotePair();
  try {
    const backend = await GitBackend.open(dir);
    await backend.fetchBranches([parseRefName("no-such-branch"), parseRefName("main")]);
    expect(await backend.branchTip(parseRefName("main"))).toBeDefined();
    expect(await backend.branchTip(parseRefName("no-such-branch"))).toBeUndefined();
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
    await backend.appendLog(parseRefName("widgets"), [
      logEntry(1748000000000, { kind: "set-parent", parent: parseRefName("main") }),
    ]);
    await backend.syncLog(parseRefName("widgets"));
    expect(await gitIn(origin, "for-each-ref", "refs/cabaret/")).not.toBe("");

    await backend.deleteLog(parseRefName("widgets"));
    expect(await backend.readLog(parseRefName("widgets"))).toEqual([]);
    expect(await gitIn(dir, "for-each-ref", "refs/cabaret/")).toBe("");
    expect(await gitIn(origin, "for-each-ref", "refs/cabaret/")).toBe("");
    // Origin already lacks the ref, as after a concurrent prune: not a failure.
    await backend.deleteLog(parseRefName("widgets"));
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
      await backend.appendLog(parseRefName(change), [
        logEntry(1748000000000, { kind: "set-parent", parent: parseRefName("main") }),
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
    ...Array.from({ length: 10 }, () => backend.branchTip(parseRefName("feature"))),
  ]);
  const tip = await git("rev-parse", "refs/heads/feature");
  expect(reads).toEqual([...Object.values(files), ...Array(10).fill(tip)]);
});

test("reads see refs and objects written after the session started", async () => {
  const backend = await GitBackend.open(repo);
  expect(await backend.readLog(parseRefName("late-arrival"))).toEqual([]);
  const entry = logEntry(1748000000000, { kind: "set-parent", parent: parseRefName("feature") });
  await backend.appendLog(parseRefName("late-arrival"), [entry]);
  expect(await backend.readLog(parseRefName("late-arrival"))).toEqual([entry]);
});

test("reads recover after the session's git process dies", async () => {
  const backend = await GitBackend.open(repo);
  const tip = await git("rev-parse", "refs/heads/feature");
  expect(await backend.branchTip(parseRefName("feature"))).toBe(tip);
  const { reader } = backend as unknown as {
    reader: { child?: { kill(): void; once(e: string, f: () => void): void } };
  };
  if (reader.child === undefined) {
    throw new Error("session did not spawn");
  }
  const closed = new Promise<void>((resolve) => reader.child?.once("close", () => resolve()));
  reader.child.kill();
  await closed;
  expect(await backend.branchTip(parseRefName("feature"))).toBe(tip);
});

test("fails fast on detached HEAD", async () => {
  const backend = await GitBackend.open(repo);
  const head = await git("rev-parse", "HEAD");
  await git("checkout", "-q", head);
  await expect(backend.currentBranch()).rejects.toThrow(
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
      { path: roots[0], branch: "main", dirty: false, primary: true },
      { path: roots[1], branch: undefined, dirty: false, primary: false },
      { path: roots[2], branch: "gadget", dirty: true, primary: false },
    ]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

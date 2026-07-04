import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  changeBase,
  type LogAction,
  type LogEntry,
  parseCommitHash,
  parseRefName,
  timestampMs,
  userName,
} from "cabaret-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { GitBackend } from "../index.js";

const execFileAsync = promisify(execFile);

let repo: string;

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repo,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
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
  await expect(backend.readLog(parseRefName("malformed"))).rejects.toThrow(/git cat-file/);
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

test("fails fast on detached HEAD with the command and stderr in the error", async () => {
  const backend = await GitBackend.open(repo);
  const head = await git("rev-parse", "HEAD");
  await git("checkout", "-q", head);
  const failure = backend.currentBranch();
  await expect(failure).rejects.toThrow(/git symbolic-ref/);
  await expect(failure).rejects.toThrow(/fatal:/);
});

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseRefName } from "cabaret-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { GitBackend } from "./index.js";

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
  expect(await backend.readLog(parseRefName("no-log-yet"))).toBe("");
});

test("readLog returns the log file's contents verbatim", async () => {
  const content = '1748000000000 alice set-base 0123abcd\n1748000060000 bob comment "looks wrong?"\n';
  await writeFile(join(repo, "log"), content);
  await git("add", "log");
  const tree = await git("write-tree");
  const commit = await git("commit-tree", tree, "-m", "cabaret log");
  await git("update-ref", "refs/cabaret/log/feature", commit);

  const backend = await GitBackend.open(repo);
  expect(await backend.readLog(parseRefName("feature"))).toBe(content);
});

test("fails fast on a log ref whose tree lacks the log file", async () => {
  const root = await git("rev-list", "--max-parents=0", "HEAD");
  await git("update-ref", "refs/cabaret/log/malformed", root);

  const backend = await GitBackend.open(repo);
  await expect(backend.readLog(parseRefName("malformed"))).rejects.toThrow(/git cat-file/);
});

test("fails fast on detached HEAD with the command and stderr in the error", async () => {
  const backend = await GitBackend.open(repo);
  const head = await git("rev-parse", "HEAD");
  await git("checkout", "-q", head);
  const failure = backend.currentBranch();
  await expect(failure).rejects.toThrow(/git symbolic-ref/);
  await expect(failure).rejects.toThrow(/fatal:/);
});

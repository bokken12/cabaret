import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { GitBackend } from "./index.js";

const execFileAsync = promisify(execFile);

let repo: string;

async function git(...args: string[]): Promise<void> {
  await execFileAsync("git", args, {
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
}

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "cabaret-node-test-"));
  await git("init", "-q");
  await writeFile(join(repo, "a.txt"), "one\n");
  await git("add", "a.txt");
  await git("commit", "-qm", "base");
  await writeFile(join(repo, "a.txt"), "two\n");
  await writeFile(join(repo, "b.txt"), "new\n");
  await git("add", ".");
  await git("commit", "-qm", "tip");
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

test("resolves revisions to commit hashes", async () => {
  const backend = await GitBackend.open(repo);
  const head = await backend.resolve("HEAD");
  expect(head).toMatch(/^[0-9a-f]{40}$/);
  expect(await backend.resolve(head)).toBe(head);
});

test("lists changed files between commits", async () => {
  const backend = await GitBackend.open(repo);
  const base = await backend.resolve("HEAD~1");
  const tip = await backend.resolve("HEAD");
  expect(await backend.changedFiles(base, tip)).toEqual(["a.txt", "b.txt"]);
  expect(await backend.changedFiles(tip, tip)).toEqual([]);
});

test("reads file contents at a commit", async () => {
  const backend = await GitBackend.open(repo);
  const base = await backend.resolve("HEAD~1");
  const tip = await backend.resolve("HEAD");
  expect(await backend.readFile(base, "a.txt")).toBe("one\n");
  expect(await backend.readFile(tip, "a.txt")).toBe("two\n");
});

test("fails fast with the command and stderr in the error", async () => {
  const backend = await GitBackend.open(repo);
  const failure = backend.resolve("no-such-branch");
  await expect(failure).rejects.toThrow(/git rev-parse .*no-such-branch/);
  await expect(failure).rejects.toThrow(/fatal:/);
});

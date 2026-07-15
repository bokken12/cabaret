import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, expect, onTestFinished, test } from "vitest";
import {
  applySetup,
  auditSetup,
  declinedScopes,
  declineSetup,
  GitBackend,
  GitUnavailableError,
  LOG_FETCH_REFSPEC,
  type SetupAudit,
} from "../index.js";

const execFileAsync = promisify(execFile);

// The backend shells out to git with this process's environment, so isolating
// its global-config writes from the host must live there too. Each test gets
// a fresh writable global config file.
process.env.GIT_CONFIG_SYSTEM = devNull;

let repo: string;

async function gitIn(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trimEnd();
}

async function git(...args: string[]): Promise<string> {
  return gitIn(repo, ...args);
}

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "cabaret-setup-test-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  process.env.GIT_CONFIG_GLOBAL = join(dir, "gitconfig");
  repo = join(dir, "repo");
  await gitIn(dir, "init", "-qb", "main", "repo");
  await git("config", "user.name", "Alice Test");
  await git("config", "user.email", "alice@example.com");
  await git("commit", "-qm", "root", "--allow-empty");
  const origin = join(dir, "origin");
  await gitIn(dir, "init", "-q", "--bare", "origin");
  await git("remote", "add", "origin", origin);
});

/** The audits keyed for comparison, shedding the recommendation's other fields. */
function keyed(audits: readonly SetupAudit[]): readonly { key: string; standing: SetupAudit["standing"] }[] {
  return audits.map(({ rec, standing }) => ({ key: rec.key, standing }));
}

test("a fresh repository audits every recommendation unset", async () => {
  const backend = await GitBackend.open(repo);
  expect(keyed(await auditSetup(backend))).toEqual([
    { key: "merge.conflictStyle", standing: { kind: "unset" } },
    { key: "rerere.enabled", standing: { kind: "unset" } },
    { key: "remote.origin.fetch", standing: { kind: "unset" } },
  ]);
});

test("apply writes each scope once and round-trips to applied", async () => {
  const backend = await GitBackend.open(repo);
  await applySetup(backend, await auditSetup(backend));
  expect(keyed(await auditSetup(backend))).toEqual([
    { key: "merge.conflictStyle", standing: { kind: "applied" } },
    { key: "rerere.enabled", standing: { kind: "applied" } },
    { key: "remote.origin.fetch", standing: { kind: "applied" } },
  ]);
  expect(await git("config", "--global", "merge.conflictStyle")).toBe("zdiff3");
  expect(await git("config", "--global", "rerere.enabled")).toBe("true");
  // A second apply sees everything applied and adds nothing.
  await applySetup(backend, await auditSetup(backend));
  expect(await git("config", "--local", "--get-all", "remote.origin.fetch")).toBe(
    `+refs/heads/*:refs/remotes/origin/*\n${LOG_FETCH_REFSPEC}`,
  );
});

test("a key set to another value is reported differing and kept", async () => {
  await git("config", "--global", "merge.conflictStyle", "diff3");
  const backend = await GitBackend.open(repo);
  const audits = await auditSetup(backend);
  expect(keyed(audits)[0]).toEqual({
    key: "merge.conflictStyle",
    standing: { kind: "differs", current: "diff3" },
  });
  await applySetup(backend, audits);
  expect(await git("config", "--global", "merge.conflictStyle")).toBe("diff3");
  expect(await git("config", "--global", "rerere.enabled")).toBe("true");
});

test("the fetch refspec is inapplicable without an origin", async () => {
  await git("remote", "remove", "origin");
  const backend = await GitBackend.open(repo);
  expect((await auditSetup(backend)).map(({ rec }) => rec.key)).toEqual(["merge.conflictStyle", "rerere.enabled"]);
});

test("once applied, a plain git fetch brings change logs down", async () => {
  const head = await git("rev-parse", "HEAD");
  await git("update-ref", "refs/cabaret/log/feature", head);
  await git("push", "-q", "origin", "refs/cabaret/log/feature");
  await git("update-ref", "-d", "refs/cabaret/log/feature");
  const backend = await GitBackend.open(repo);
  await applySetup(backend, await auditSetup(backend));
  await git("fetch", "-q", "origin");
  expect(await git("rev-parse", "refs/cabaret/remote-log/feature")).toBe(head);
});

test("declines are recorded per scope", async () => {
  const backend = await GitBackend.open(repo);
  expect(await declinedScopes(backend)).toEqual(new Set());
  await declineSetup(backend, ["local"]);
  expect(await declinedScopes(backend)).toEqual(new Set(["local"]));
  await declineSetup(backend, ["global"]);
  expect(await declinedScopes(backend)).toEqual(new Set(["local", "global"]));
});

test("a missing git binary surfaces as guidance, not a raw spawn error", async () => {
  const path = process.env.PATH;
  process.env.PATH = "";
  try {
    await expect(GitBackend.open(repo)).rejects.toThrow(GitUnavailableError);
  } finally {
    process.env.PATH = path;
  }
});

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { run } from "@stricli/core";
import { type Forge, timestampMs } from "cabaret-core";
import { GitBackend, NoForgeError } from "cabaret-node";
import { expect, onTestFinished } from "vitest";
import { app } from "../../app.js";
import type { LocalContext } from "../../context.js";
import { FakeForge } from "./fake-forge.js";

const execFileAsync = promisify(execFile);

// Cabaret itself shells out to git, so isolation from the host's git config
// must live in this process's environment, not in per-call overrides.
process.env.GIT_CONFIG_GLOBAL = devNull;
process.env.GIT_CONFIG_SYSTEM = devNull;
// Pin commit timestamps so hashes, which appear in 4-way diff output, are
// stable across runs.
process.env.GIT_AUTHOR_DATE = "2025-01-01T00:00:00 +0000";
process.env.GIT_COMMITTER_DATE = "2025-01-01T00:00:00 +0000";

/** Everything a user observes from one CLI invocation. */
export interface Invocation {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | string;
}

export interface TestRepo {
  git(...args: string[]): Promise<string>;
  /** Like `git`, feeding `stdin` to the command. */
  gitStdin(stdin: string, ...args: string[]): Promise<string>;
  /** Write `content` to `path` in the working tree, creating directories as needed. */
  write(path: string, content: string): Promise<void>;
  /** Run `cab <argv>` against this repo in-process, capturing all output. */
  cabaret(...argv: string[]): Promise<Invocation>;
  /** Like `cabaret`, but invoked from `subdir` of the working tree. */
  cabaretIn(subdir: string, ...argv: string[]): Promise<Invocation>;
  /** Jump the repo's clock forward, as if `ms` passed between commands. */
  advanceClock(ms: number): void;
}

/** `dev log`'s stdout for `argv`, asserting the invocation succeeded silently. */
export async function shownLog(repo: TestRepo, ...argv: string[]): Promise<string> {
  const { stdout, stderr, exitCode } = await repo.cabaret("dev", "log", ...argv);
  expect({ stderr, exitCode }).toEqual({ stderr: "", exitCode: 0 });
  return stdout;
}

/** The Comments section of a change's show page, or "" when it has none. */
export async function shownComments(repo: TestRepo, ...argv: string[]): Promise<string> {
  const { stdout } = await repo.cabaret("show", ...argv);
  const start = stdout.indexOf("Comments:");
  if (start === -1) {
    return "";
  }
  const end = stdout.indexOf("\nFiles to review:", start);
  return end === -1 ? stdout.slice(start) : stdout.slice(start, end);
}

/**
 * Create change `name` stacked on the current branch, with one commit adding
 * `<name>.txt`, reviewing everyone — pushed ready, so a sync opens its forge
 * change.
 */
export async function addChange(repo: TestRepo, name: string): Promise<void> {
  await repo.cabaret("create", name);
  await repo.cabaret("reviewing", "set", "everyone", "--change", name);
  await repo.git("checkout", "-q", name);
  await repo.write(`${name}.txt`, `${name} work\n`);
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", `${name} work`);
}

/** A throwaway directory, removed when the current test finishes. */
export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Pages' fetched footers date FETCH_HEAD mtimes, so stable snapshots need
// those pinned like commit timestamps.
const FETCHED_AT = new Date("2025-01-01T00:00:00Z");

/** Set every FETCH_HEAD under `dir`'s repo — the primary's and each worktree's — to `FETCHED_AT`. */
async function pinFetched(dir: string): Promise<void> {
  const gitDir = join(dir, ".git");
  const files = [join(gitDir, "FETCH_HEAD")];
  try {
    const worktrees = join(gitDir, "worktrees");
    files.push(...(await readdir(worktrees)).map((name) => join(worktrees, name, "FETCH_HEAD")));
  } catch {
    // No worktrees directory.
  }
  await Promise.all(
    files.map(async (file) => {
      try {
        await utimes(file, FETCHED_AT, FETCHED_AT);
      } catch {
        // Never fetched there.
      }
    }),
  );
}

/** A `TestRepo` over an initialized repo at `dir`, its clock starting at `clockStart`. */
function wrapRepo(dir: string, forge: Forge | undefined, clockStart: number): TestRepo {
  const git = async (...args: string[]) => {
    const { stdout } = await execFileAsync("git", args, { cwd: dir });
    await pinFetched(dir);
    return stdout.trimEnd();
  };

  const gitStdin = async (stdin: string, ...args: string[]) => {
    const pending = execFileAsync("git", args, { cwd: dir });
    pending.child.stdin?.end(stdin);
    const { stdout } = await pending;
    await pinFetched(dir);
    return stdout.trimEnd();
  };

  let clock = clockStart;
  const cabaretIn = async (subdir: string, ...argv: string[]) => {
    const captured = { stdout: "", stderr: "" };
    const capture = (stream: "stdout" | "stderr") => ({
      write(chunk: string): boolean {
        captured[stream] += chunk;
        return true;
      },
    });
    const proc: LocalContext["process"] = { stdout: capture("stdout"), stderr: capture("stderr") };
    const context: LocalContext = {
      process: proc,
      backend: () => GitBackend.open(join(dir, subdir)),
      forge: async () => {
        if (forge === undefined) {
          throw new NoForgeError("this test repo has no forge");
        }
        return forge;
      },
      now: () => timestampMs(clock++),
    };
    await run(app, argv, context);
    await pinFetched(dir);
    return { ...captured, exitCode: proc.exitCode ?? 0 };
  };
  const cabaret = (...argv: string[]) => cabaretIn("", ...argv);

  const write = async (path: string, content: string) => {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  };

  return {
    git,
    gitStdin,
    write,
    cabaret,
    cabaretIn,
    advanceClock: (ms) => {
      clock += ms;
    },
  };
}

/**
 * A throwaway repo on `main` with one empty root commit, the identity
 * `alice@example.com`, and a bare `origin` remote, removed when the current
 * test finishes. Each repo's clock starts at a fixed epoch and ticks one
 * millisecond per read, so all command output is deterministic. `forge`, when
 * given, is what the `gh` commands talk to; without it they fail. `nest`
 * places the repo in a subdirectory of that name, so sibling workspaces get
 * deterministic relative paths.
 */
export async function makeRepo(forge?: Forge, nest?: string): Promise<TestRepo> {
  let dir = await tempDir("cabaret-e2e-");
  if (nest !== undefined) {
    dir = join(dir, nest);
    await mkdir(dir);
  }
  const repo = wrapRepo(dir, forge, 1748000000000);
  await repo.git("init", "-qb", "main");
  await repo.git("config", "user.name", "Alice Test");
  await repo.git("config", "user.email", "alice@example.com");
  await repo.git("commit", "-qm", "root", "--allow-empty");
  const origin = await tempDir("cabaret-e2e-origin-");
  await execFileAsync("git", ["init", "-q", "--bare", origin]);
  await repo.git("remote", "add", "origin", origin);
  if (forge instanceof FakeForge) {
    forge.origin = origin;
  }
  return repo;
}

/**
 * A second machine of `source`'s project: a clone of its origin under the
 * identity `email`, with a clock 100 seconds ahead so its entries never
 * collide with the source's. Push `main` before cloning so the clone has a
 * branch to stand on.
 */
export async function makeClone(source: TestRepo, email: string, forge?: Forge): Promise<TestRepo> {
  const origin = await source.git("remote", "get-url", "origin");
  const dir = await tempDir("cabaret-e2e-clone-");
  await execFileAsync("git", ["clone", "-q", origin, dir]);
  const repo = wrapRepo(dir, forge, 1748000100000);
  await repo.git("config", "user.name", "Bob Test");
  await repo.git("config", "user.email", email);
  return repo;
}

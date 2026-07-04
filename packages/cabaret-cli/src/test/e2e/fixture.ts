import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { run } from "@stricli/core";
import { timestampMs } from "cabaret-core";
import { GitBackend } from "cabaret-node";
import { onTestFinished } from "vitest";
import { app } from "../../app.js";
import type { LocalContext } from "../../context.js";

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
  /** Write `content` to `path` in the working tree, creating directories as needed. */
  write(path: string, content: string): Promise<void>;
  /** Run `cabaret <argv>` against this repo in-process, capturing all output. */
  cabaret(...argv: string[]): Promise<Invocation>;
}

/**
 * A throwaway repo on `main` with one empty root commit and the identity
 * `alice@example.com`, removed when the current test finishes. Each repo's
 * clock starts at a fixed epoch and ticks one millisecond per read, so all
 * command output is deterministic.
 */
export async function makeRepo(): Promise<TestRepo> {
  const dir = await mkdtemp(join(tmpdir(), "cabaret-e2e-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const git = async (...args: string[]) => {
    const { stdout } = await execFileAsync("git", args, { cwd: dir });
    return stdout.trimEnd();
  };
  await git("init", "-qb", "main");
  await git("config", "user.name", "Alice Test");
  await git("config", "user.email", "alice@example.com");
  await git("commit", "-qm", "root", "--allow-empty");

  let clock = 1748000000000;
  const cabaret = async (...argv: string[]) => {
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
      backend: () => GitBackend.open(dir),
      now: () => timestampMs(clock++),
    };
    await run(app, argv, context);
    return { ...captured, exitCode: proc.exitCode ?? 0 };
  };

  const write = async (path: string, content: string) => {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  };

  return { git, write, cabaret };
}

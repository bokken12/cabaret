import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ExitCode, run } from "@stricli/core";
import { GitBackend } from "cabaret-node";
import { afterEach, expect, test } from "vitest";
import { app } from "./app.js";
import type { LocalContext } from "./context.js";

const execFileAsync = promisify(execFile);

// Cabaret itself shells out to git, so isolation from the host's git config
// must live in this process's environment, not in per-call overrides.
process.env.GIT_CONFIG_GLOBAL = devNull;
process.env.GIT_CONFIG_SYSTEM = devNull;

/** Everything a user observes from one CLI invocation. */
interface Invocation {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | string;
}

interface TestRepo {
  git(...args: string[]): Promise<string>;
  /** Run `cabaret <argv>` against this repo in-process, capturing all output. */
  cabaret(...argv: string[]): Promise<Invocation>;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

/**
 * A throwaway repo on `main` with one empty root commit and the identity
 * `alice@example.com`, isolated from the host's git config. Each repo's clock
 * starts at a fixed epoch and ticks one millisecond per read, so all command
 * output is deterministic.
 */
async function makeRepo(): Promise<TestRepo> {
  const dir = await mkdtemp(join(tmpdir(), "cabaret-e2e-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
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
      now: () => clock++,
    };
    await run(app, argv, context);
    return { ...captured, exitCode: proc.exitCode ?? 0 };
  };

  return { git, cabaret };
}

test("reparent then log round-trips a set-parent entry", async () => {
  const repo = await makeRepo();
  await repo.git("checkout", "-qb", "feature");
  expect(await repo.cabaret("reparent", "feature", "main")).toEqual({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  expect(await repo.cabaret("log", "feature")).toEqual({
    stdout: "1748000000000 alice@example.com set-parent main\n",
    stderr: "",
    exitCode: 0,
  });
});

test("reparent appends to an existing log", async () => {
  const repo = await makeRepo();
  await repo.cabaret("reparent", "gadget", "main");
  await repo.cabaret("reparent", "gadget", "feature/base");
  expect(await repo.cabaret("log", "gadget")).toMatchInlineSnapshot(`
    {
      "exitCode": 0,
      "stderr": "",
      "stdout": "1748000000000 alice@example.com set-parent main
    1748000000001 alice@example.com set-parent feature/base
    ",
    }
  `);
});

test("log defaults to the change of the checked-out branch", async () => {
  const repo = await makeRepo();
  await repo.cabaret("reparent", "main", "trunk");
  expect(await repo.cabaret("log")).toEqual({
    stdout: "1748000000000 alice@example.com set-parent trunk\n",
    stderr: "",
    exitCode: 0,
  });
});

test("a change with no log has the empty log", async () => {
  const repo = await makeRepo();
  expect(await repo.cabaret("log", "unlogged")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("rejects a malformed change name", async () => {
  const repo = await makeRepo();
  const result = await repo.cabaret("log", "not..a..ref");
  expect(result.exitCode).toBe(ExitCode.InvalidArgument);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain('not a valid ref name: "not..a..ref"');
});

test("reparent fails without a git identity, leaving the log untouched", async () => {
  const repo = await makeRepo();
  await repo.git("config", "--unset", "user.email");
  const result = await repo.cabaret("reparent", "main", "trunk");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("git config user.email");
  expect(await repo.cabaret("log", "main")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("reparent rejects an empty git identity", async () => {
  const repo = await makeRepo();
  await repo.git("config", "user.email", "");
  const result = await repo.cabaret("reparent", "main", "trunk");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("git config user.email must be a single nonempty word");
  expect(await repo.cabaret("log", "main")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

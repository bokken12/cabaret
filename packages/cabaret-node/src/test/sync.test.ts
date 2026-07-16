import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type CommitHash,
  currentParent,
  formatLogEntry,
  type LogAction,
  type LogEntry,
  parseRefName,
  timestampMs,
  userName,
} from "cabaret-core";
import { expect, onTestFinished, test } from "vitest";
import { GitBackend } from "../index.js";

const execFileAsync = promisify(execFile);

// The backend shells out to git with this process's environment, so isolation
// from the host's git config must live there too, not in per-call overrides.
process.env.GIT_CONFIG_GLOBAL = devNull;
process.env.GIT_CONFIG_SYSTEM = devNull;

/** One "machine": a repo with `bare` as its origin, plus a backend on it. */
interface Machine {
  readonly backend: GitBackend;
  git(...args: string[]): Promise<string>;
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A shared bare origin and two repos pointing at it: two machines of one
 * project, both on this machine, so distributed flows run deterministically
 * under vitest. The repos share no history — logs alone tie them together.
 */
async function makeMachines(): Promise<readonly [Machine, Machine]> {
  const origin = await tempDir("cabaret-sync-origin-");
  await execFileAsync("git", ["init", "-q", "--bare", origin]);
  const machine = async (email: string): Promise<Machine> => {
    const dir = await tempDir("cabaret-sync-");
    const git = async (...args: string[]) => {
      const { stdout } = await execFileAsync("git", args, { cwd: dir });
      return stdout.trimEnd();
    };
    await git("init", "-q");
    await git("config", "user.name", "Test User");
    await git("config", "user.email", email);
    await git("remote", "add", "origin", origin);
    return { backend: await GitBackend.open(dir), git };
  };
  return [await machine("alice@example.com"), await machine("bob@example.com")];
}

function entry(timestamp: number, user: string, action: LogAction<CommitHash>): LogEntry<CommitHash> {
  return { timestamp: timestampMs(timestamp), user: userName(user), action };
}

function setParent(timestamp: number, user: string, parent: string): LogEntry<CommitHash> {
  return entry(timestamp, user, { kind: "set-parent", parent: parseRefName(parent) });
}

const WIDGETS = parseRefName("widgets");

interface LogState {
  readonly blob: string;
  readonly ref: string;
}

/** Both machines' logs for `change`, as bytes and refs, for convergence checks. */
async function logStates(machines: readonly [Machine, Machine], change: string): Promise<[LogState, LogState]> {
  const state = async ({ git }: Machine): Promise<LogState> => ({
    blob: await git("cat-file", "blob", `refs/cabaret/log/${change}:log`),
    ref: await git("rev-parse", `refs/cabaret/log/${change}`),
  });
  return [await state(machines[0]), await state(machines[1])];
}

test("syncLog publishes a log and a fresh machine adopts it verbatim", async () => {
  const [a, b] = await makeMachines();
  const entries = [setParent(1000, "alice@example.com", "main")];
  await a.backend.appendLog(WIDGETS, entries);
  await a.backend.syncLog(WIDGETS);
  expect(await b.backend.readLog(WIDGETS)).toEqual([]);
  await b.backend.syncLog(WIDGETS);
  expect(await b.backend.readLog(WIDGETS)).toEqual(entries);
  const [stateA, stateB] = await logStates([a, b], "widgets");
  expect(stateB).toEqual(stateA);
});

test("concurrent appends converge to byte-identical logs, ties resolved alike", async () => {
  const [a, b] = await makeMachines();
  // The same entry recorded independently on both machines (as two `cabaret pull`s
  // of one forge comment would), plus a genuine equal-timestamp conflict.
  const shared = entry(500, "carol@example.com", { kind: "comment", text: "please split this" });
  const aParent = setParent(1000, "alice@example.com", "trunk-a");
  const bParent = setParent(1000, "bob@example.com", "trunk-b");
  await a.backend.appendLog(WIDGETS, [shared, aParent]);
  await b.backend.appendLog(WIDGETS, [shared, bParent]);
  await a.backend.syncLog(WIDGETS);
  await b.backend.syncLog(WIDGETS);
  await a.backend.syncLog(WIDGETS);
  const merged = [shared, aParent, bParent];
  expect(await a.backend.readLog(WIDGETS)).toEqual(merged);
  expect(await b.backend.readLog(WIDGETS)).toEqual(merged);
  const [stateA, stateB] = await logStates([a, b], "widgets");
  expect(stateA).toEqual(stateB);
  expect(stateA.blob).toBe(merged.map(formatLogEntry).join("").trimEnd());
  // The tie breaks on the serialized entry, identically on both machines.
  expect(currentParent(WIDGETS, await a.backend.readLog(WIDGETS))).toBe("trunk-b");
  expect(currentParent(WIDGETS, await b.backend.readLog(WIDGETS))).toBe("trunk-b");
});

test("a converged log syncs as a no-op", async () => {
  const [a, b] = await makeMachines();
  await a.backend.appendLog(WIDGETS, [setParent(1000, "alice@example.com", "main")]);
  await a.backend.syncLog(WIDGETS);
  await b.backend.syncLog(WIDGETS);
  const before = await logStates([a, b], "widgets");
  await a.backend.syncLog(WIDGETS);
  await b.backend.syncLog(WIDGETS);
  expect(await logStates([a, b], "widgets")).toEqual(before);
});

test("appends after convergence flow both ways as fast-forwards", async () => {
  const [a, b] = await makeMachines();
  await a.backend.appendLog(WIDGETS, [setParent(1000, "alice@example.com", "main")]);
  await a.backend.syncLog(WIDGETS);
  await b.backend.syncLog(WIDGETS);
  const late = setParent(2000, "bob@example.com", "trunk");
  await b.backend.appendLog(WIDGETS, [late]);
  await b.backend.syncLog(WIDGETS);
  await a.backend.syncLog(WIDGETS);
  expect(await a.backend.readLog(WIDGETS)).toEqual([setParent(1000, "alice@example.com", "main"), late]);
  const [stateA, stateB] = await logStates([a, b], "widgets");
  expect(stateA).toEqual(stateB);
});

test("syncLogs sweeps every change, local and remote alike, sorted", async () => {
  const [a, b] = await makeMachines();
  expect(await a.backend.syncLogs()).toEqual([]);
  await a.backend.appendLog(WIDGETS, [setParent(1000, "alice@example.com", "main")]);
  await a.backend.appendLog(parseRefName("api"), [setParent(1001, "alice@example.com", "main")]);
  expect(await a.backend.syncLogs()).toEqual(["api", "widgets"]);
  await b.backend.appendLog(parseRefName("docs"), [setParent(1002, "bob@example.com", "main")]);
  expect(await b.backend.syncLogs()).toEqual(["api", "docs", "widgets"]);
  expect(await b.backend.readLog(WIDGETS)).toEqual([setParent(1000, "alice@example.com", "main")]);
  expect(await a.backend.syncLogs()).toEqual(["api", "docs", "widgets"]);
  expect(await a.backend.readLog(parseRefName("docs"))).toEqual([setParent(1002, "bob@example.com", "main")]);
});

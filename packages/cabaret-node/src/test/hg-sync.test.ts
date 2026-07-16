import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { currentParent, formatLogEntry, type LogAction, type LogEntry, timestampMs, userName } from "cabaret-core";
import { expect, onTestFinished, test } from "vitest";
import { HgBackend, type HgName, type HgNode, parseHgName, parseHgNode } from "../index.js";

const execFileAsync = promisify(execFile);

/** One "machine": a repo with the shared origin as its default path, plus a backend on it. */
interface Machine {
  readonly dir: string;
  readonly backend: HgBackend;
  hg(...args: string[]): Promise<string>;
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function hgIn(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("hg", args, {
    cwd,
    env: { ...process.env, HGPLAIN: "1", HGRCPATH: "/dev/null" },
  });
  return stdout.trimEnd();
}

/**
 * A shared origin and two repos pointing at it: two machines of one project,
 * both on this machine, so distributed flows run deterministically under
 * vitest. The repos share no history — logs alone tie them together.
 */
async function makeMachines(): Promise<readonly [Machine, Machine]> {
  const origin = await tempDir("cabaret-hg-sync-origin-");
  await hgIn(origin, "init");
  const machine = async (email: string): Promise<Machine> => {
    const dir = await tempDir("cabaret-hg-sync-");
    await hgIn(dir, "init");
    await writeFile(join(dir, ".hg", "hgrc"), `[ui]\nusername = Test User <${email}>\n[paths]\ndefault = ${origin}\n`);
    return {
      dir,
      backend: await HgBackend.open(dir),
      hg: (...args: string[]) => hgIn(dir, ...args),
    };
  };
  return [await machine("alice@example.com"), await machine("bob@example.com")];
}

function entry(timestamp: number, user: string, action: LogAction<HgNode, HgName>): LogEntry<HgNode, HgName> {
  return { timestamp: timestampMs(timestamp), user: userName(user), action };
}

function setParent(timestamp: number, user: string, parent: string): LogEntry<HgNode, HgName> {
  return entry(timestamp, user, { kind: "set-parent", parent: parseHgName(parent) });
}

const WIDGETS = parseHgName("widgets");

interface LogState {
  readonly blob: string;
  readonly node: string;
}

/** Both machines' logs for `change`, as bytes and chain-tip nodes, for convergence checks. */
async function logStates(machines: readonly [Machine, Machine], change: string): Promise<[LogState, LogState]> {
  const state = async ({ hg }: Machine): Promise<LogState> => ({
    blob: await hg("cat", "-r", 'bookmark("cabaret/log")', `path:logs/${change}`),
    node: await hg("log", "-r", 'bookmark("cabaret/log")', "-T", "{node}"),
  });
  return [await state(machines[0]), await state(machines[1])];
}

test("syncLog publishes a log and a fresh machine adopts it verbatim", { timeout: 60000 }, async () => {
  const [a, b] = await makeMachines();
  const entries = [setParent(1000, "alice@example.com", "main")];
  await a.backend.appendLog(WIDGETS, entries);
  await a.backend.syncLog(WIDGETS);
  expect(await b.backend.readLog(WIDGETS)).toEqual([]);
  await b.backend.syncLog(WIDGETS);
  expect(await b.backend.readLog(WIDGETS)).toEqual(entries);
  const [stateA, stateB] = await logStates([a, b], "widgets");
  expect(stateB).toEqual(stateA);
  // Publishing made the log public on both sides; nothing is left outgoing,
  // so the user's own `hg push` has nothing of Cabaret's to trip over.
  expect(await a.hg("log", "-r", "secret() or draft()", "-T", "{node}")).toBe("");
  // The record of origin's cabaret/log bookmark is no reading of a code
  // bookmark, and the chain stays out of hg's branch and head listings.
  expect(await a.backend.originTip(WIDGETS)).toBe(undefined);
  expect(await a.hg("bookmarks", "-T", "{bookmark}\n")).toBe("cabaret/log");
  expect(await a.hg("branches", "-T", "{branch}\n")).toBe("");
  expect(await a.hg("log", "-r", "head() and not closed()", "-T", "{branch}\n")).toBe("");
});

test("concurrent appends converge to byte-identical logs, ties resolved alike", { timeout: 60000 }, async () => {
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

test("a converged log syncs as a no-op", { timeout: 60000 }, async () => {
  const [a, b] = await makeMachines();
  await a.backend.appendLog(WIDGETS, [setParent(1000, "alice@example.com", "main")]);
  await a.backend.syncLog(WIDGETS);
  await b.backend.syncLog(WIDGETS);
  const before = await logStates([a, b], "widgets");
  await a.backend.syncLog(WIDGETS);
  await b.backend.syncLog(WIDGETS);
  expect(await logStates([a, b], "widgets")).toEqual(before);
});

test("appends after convergence flow both ways as fast-forwards", { timeout: 60000 }, async () => {
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

test("syncLogs sweeps every change, local and remote alike, sorted", { timeout: 60000 }, async () => {
  const [a, b] = await makeMachines();
  expect(await a.backend.syncLogs()).toEqual([]);
  await a.backend.appendLog(WIDGETS, [setParent(1000, "alice@example.com", "main")]);
  await a.backend.appendLog(parseHgName("api"), [setParent(1001, "alice@example.com", "main")]);
  expect(await a.backend.syncLogs()).toEqual(["api", "widgets"]);
  await b.backend.appendLog(parseHgName("docs"), [setParent(1002, "bob@example.com", "main")]);
  expect(await b.backend.syncLogs()).toEqual(["api", "docs", "widgets"]);
  expect(await b.backend.readLog(WIDGETS)).toEqual([setParent(1000, "alice@example.com", "main")]);
  expect(await a.backend.syncLogs()).toEqual(["api", "docs", "widgets"]);
  expect(await a.backend.readLog(parseHgName("docs"))).toEqual([setParent(1002, "bob@example.com", "main")]);
});

/** Commit `files` on `machine` and return the new changeset id. */
async function commit(machine: Machine, message: string, files: Record<string, string>): Promise<HgNode> {
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(machine.dir, path), content);
  }
  await machine.hg("add", "-q", ...Object.keys(files).map((path) => `path:${path}`));
  await machine.hg("commit", "-q", "-m", message);
  return parseHgNode(await machine.hg("log", "-r", ".", "-T", "{node}"));
}

test("push and fetch move code branches, and originTip tracks what was seen", {
  timeout: 60000,
}, async () => {
  const [a, b] = await makeMachines();
  const main = parseHgName("main");
  // A synced log first: origin then already has a named branch, so the code
  // push is the "push creates new remote branches" case, not an empty-repo one.
  await a.backend.appendLog(WIDGETS, [setParent(1000, "alice@example.com", "main")]);
  await a.backend.syncLog(WIDGETS);
  const first = await commit(a, "root", { "f.txt": "one\n" });
  await a.hg("bookmark", "-r", ".", "main");
  await a.backend.push(main);
  expect(await a.backend.originTip(main)).toBe(first);

  expect(await b.backend.tip(main)).toBe(undefined);
  await b.backend.fetch(main);
  expect(await b.backend.tip(main)).toBe(first);
  expect(await b.backend.originTip(main)).toBe(first);

  // a advances and pushes; b fast-forwards, carrying its checkout along.
  await a.hg("update", "-q", "main");
  const second = await commit(a, "more", { "f.txt": "one\ntwo\n" });
  await a.hg("bookmark", "-q", "-f", "-r", ".", "main");
  await a.backend.push(main);
  await b.hg("update", "-q", "main");
  await b.backend.fetch(main);
  expect(await b.backend.tip(main)).toBe(second);
  expect(await b.hg("log", "-r", ".", "-T", "{node}")).toBe(second);

  // With remotenames enabled in config — Cabaret's own setup recommends it —
  // records of origin's bookmarks must not read as local branches.
  await b.backend.configSet("extensions.remotenames", "", "local");
  expect(await b.backend.tip(parseHgName("default/main"))).toBe(undefined);
  expect(await b.backend.listChanges()).toEqual([]);
  expect(await b.backend.tip(main)).toBe(second);
});

test("push replaces a rewritten branch under lease, but never unseen work", { timeout: 60000 }, async () => {
  const [a, b] = await makeMachines();
  const feature = parseHgName("feature");
  await commit(a, "base", { "f.txt": "base\n" });
  await a.hg("bookmark", "-r", ".", "feature");
  await a.backend.push(feature);
  await b.backend.fetch(feature);

  // b "rewrites" the branch: a sibling commit replaces the fetched tip.
  await b.hg("update", "-q", "null");
  const rewritten = await commit(b, "rewrite", { "g.txt": "rewritten\n" });
  await b.hg("bookmark", "-q", "-f", "-r", ".", "feature");
  // b saw origin's tip when it fetched, so the replacement is within its lease.
  await b.backend.push(feature);

  // a, still holding the old tip, has never fetched the rewrite: refused.
  await a.hg("update", "-q", "feature");
  await commit(a, "stale work", { "f.txt": "base\nstale\n" });
  await a.hg("bookmark", "-q", "-f", "-r", ".", "feature");
  await expect(a.backend.push(feature)).rejects.toThrow(
    'origin\'s copy of "feature" has work this repository never fetched',
  );
  // After fetching (and diverging), the branch is b's to resolve — but the
  // fetch itself must refuse to overwrite a's local work.
  await expect(a.backend.fetch(feature)).rejects.toThrow('bookmark has diverged from origin: "feature"');
  expect(await a.hg("bookmarks", "-T", "{bookmark}\\n")).not.toContain("feature@default");
  void rewritten;
});

test("deleteLog deletes the log locally and on origin, tolerating a repeat", { timeout: 60000 }, async () => {
  const [a, b] = await makeMachines();
  await a.backend.appendLog(WIDGETS, [setParent(1000, "alice@example.com", "main")]);
  await a.backend.syncLog(WIDGETS);
  await b.backend.syncLog(WIDGETS);
  await a.backend.deleteLog(WIDGETS);
  expect(await a.backend.readLog(WIDGETS)).toEqual([]);
  expect(await a.backend.listChanges()).toEqual([]);
  await a.backend.deleteLog(WIDGETS);
  // b still holds its copy locally, but origin no longer serves the log.
  await b.backend.deleteLog(WIDGETS);
  expect(await b.backend.listChanges()).toEqual([]);
  expect(await a.backend.syncLogs()).toEqual([]);
});

test("wipeReviewState forgets local logs and a sync restores them from origin", { timeout: 60000 }, async () => {
  const [a, b] = await makeMachines();
  const entries = [setParent(1000, "alice@example.com", "main")];
  await a.backend.appendLog(WIDGETS, entries);
  await a.backend.syncLog(WIDGETS);
  expect(await a.backend.wipeReviewState()).toEqual(["widgets"]);
  expect(await a.backend.readLog(WIDGETS)).toEqual([]);
  await a.backend.syncLog(WIDGETS);
  expect(await a.backend.readLog(WIDGETS)).toEqual(entries);
  void b;
});

test("wipeOriginLogs deletes every log on origin, for every change", { timeout: 60000 }, async () => {
  const [a, b] = await makeMachines();
  await a.backend.appendLog(WIDGETS, [setParent(1000, "alice@example.com", "main")]);
  await a.backend.appendLog(parseHgName("api"), [setParent(1001, "alice@example.com", "main")]);
  await a.backend.syncLogs();
  expect(await a.backend.wipeOriginLogs()).toEqual(["api", "widgets"]);
  // A fresh machine now sees no logs on origin.
  expect(await b.backend.syncLogs()).toEqual([]);
  expect(await b.backend.listChanges()).toEqual([]);
});

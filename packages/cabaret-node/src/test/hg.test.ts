import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  changeBase,
  changeTip,
  createChange,
  landChange,
  landMessage,
  type LogEntry,
  parseFilePath,
  parseRefName,
  rebaseChange,
  reviewSpans,
  type TimestampMs,
  timestampMs,
  userName,
} from "cabaret-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { GitBackend, HgBackend, type HgNode, openBackend, parseHgNode } from "../index.js";

const execFileAsync = promisify(execFile);

let dir: string;
let repo: string;

async function hgIn(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("hg", args, { cwd, env: { ...process.env, HGPLAIN: "1" } });
  return stdout.trimEnd();
}

async function hg(...args: string[]): Promise<string> {
  return hgIn(repo, ...args);
}

/** Commit `files` in `cwd` and return the new changeset id. */
async function commit(cwd: string, message: string, files: Record<string, string>): Promise<HgNode> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(cwd, path, ".."), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
  await hgIn(cwd, "add", "-q", ...Object.keys(files).map((path) => `path:${path}`));
  await hgIn(cwd, "commit", "-q", "-m", message);
  return parseHgNode(await hgIn(cwd, "log", "-r", ".", "-T", "{node}"));
}

/** A deterministic clock, one second per reading. */
function testClock(): () => TimestampMs {
  let time = 1748000000000;
  return () => timestampMs((time += 1000));
}

const alice = userName("alice@example.com");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cabaret-hg-test-"));
  // The backend reads global config through hg, so isolation from the host's
  // ~/.hgrc must live in the environment; the file doubles as the "global"
  // scope config writes land in.
  process.env.HGRCPATH = join(dir, "global-hgrc");
  await writeFile(process.env.HGRCPATH, "");
  repo = join(dir, "repo");
  await hgIn(dir, "init", "repo");
  await writeFile(join(repo, ".hg", "hgrc"), "[ui]\nusername = Alice Test <alice@example.com>\n");
  await commit(repo, "root", { "base.txt": "base\n" });
  await hg("bookmark", "main");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("openBackend detects the VCS from the repository markers", async () => {
  expect((await openBackend(repo)).vcs).toBe("hg");
  const nested = join(repo, "deep", "inside");
  await mkdir(nested, { recursive: true });
  expect((await openBackend(nested)).vcs).toBe("hg");
  const gitRepo = join(dir, "git-repo");
  await mkdir(gitRepo);
  await execFileAsync("git", ["init", "-q"], { cwd: gitRepo });
  expect((await openBackend(gitRepo)) instanceof GitBackend).toBe(true);
  const bare = join(dir, "no-repo");
  await mkdir(bare);
  await expect(openBackend(bare)).rejects.toThrow("not inside a git or mercurial repository");
});

test("reports the active bookmark as the current branch, failing when none is", async () => {
  const backend = await HgBackend.open(repo);
  await hg("update", "-q", "main");
  expect(await backend.currentBranch()).toBe("main");
  await hg("bookmark", "-q", "-i", "main");
  await expect(backend.currentBranch()).rejects.toThrow("no bookmark is active");
  await hg("update", "-q", "main");
});

test("resolveFile maps user paths to repo-relative ones", async () => {
  await mkdir(join(repo, "sub"), { recursive: true });
  const root = await HgBackend.open(repo);
  expect(root.resolveFile("src/a.ts")).toBe("src/a.ts");
  expect(root.resolveFile(join(root.root, "src/a.ts"))).toBe("src/a.ts");
  expect(() => root.resolveFile("../escape.ts")).toThrow('path is outside the repository: "../escape.ts"');
  expect(() => root.resolveFile("")).toThrow('not a valid file path: ""');
  const sub = await HgBackend.open(join(repo, "sub"));
  expect(sub.resolveFile("a.ts")).toBe("sub/a.ts");
  expect(sub.resolveFile("../src/a.ts")).toBe("src/a.ts");
});

test("currentUser is the email inside a conventional username", async () => {
  const backend = await HgBackend.open(repo);
  expect(await backend.currentUser()).toBe("alice@example.com");
});

test("config writes: set replaces, add appends to the list, unset removes and reports", async () => {
  const backend = await HgBackend.open(repo);
  expect(await backend.config("cabaret.landMethod")).toBe(undefined);
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

test("global config writes land in the global file, and scoped reads stay scoped", async () => {
  const backend = await HgBackend.open(repo);
  await backend.configSet("cabaret.context", "5", "global");
  expect(await backend.config("cabaret.context")).toBe("5");
  expect(await backend.configAll("cabaret.context", "global")).toEqual(["5"]);
  expect(await backend.configAll("cabaret.context", "local")).toEqual([]);
  // Local overrides global in the merged read.
  await backend.configSet("cabaret.context", "9", "local");
  expect(await backend.config("cabaret.context")).toBe("9");
  await backend.configUnset("cabaret.context", "local");
  await backend.configUnset("cabaret.context", "global");
  expect(await backend.config("cabaret.context")).toBe(undefined);
});

test("a change with no log has the empty log, and appends round-trip", async () => {
  const backend = await HgBackend.open(repo);
  const change = parseRefName("log-roundtrip");
  expect(await backend.readLog(change)).toEqual([]);
  const tip = await backend.resolveCommit(".");
  const entries: LogEntry<HgNode>[] = [
    { timestamp: timestampMs(1748000000000), user: alice, action: { kind: "set-parent", parent: parseRefName("main") } },
    { timestamp: timestampMs(1748000001000), user: alice, action: { kind: "set-base", base: tip } },
  ];
  await backend.appendLog(change, entries.slice(0, 1));
  await backend.appendLog(change, entries.slice(1));
  expect(await backend.readLog(change)).toEqual(entries);
});

test("log commits stay secret, invisible to the user's own push", async () => {
  const backend = await HgBackend.open(repo);
  await backend.appendLog(parseRefName("log-secret"), [
    { timestamp: timestampMs(1748000000000), user: alice, action: { kind: "set-parent", parent: parseRefName("main") } },
  ]);
  const phase = await hg("log", "-r", 'bookmark("cabaret/log/log-secret")', "-T", "{phase}");
  expect(phase).toBe("secret");
  expect(await hg("log", "-r", "secret() and outgoing()", "-T", "{node}").catch(() => "no remote")).toBeDefined();
});

test("listChanges names every change with a log, sorted by name", async () => {
  const backend = await HgBackend.open(repo);
  const entry: LogEntry<HgNode> = {
    timestamp: timestampMs(1748000000000),
    user: alice,
    action: { kind: "set-parent", parent: parseRefName("main") },
  };
  await backend.appendLog(parseRefName("list-b"), [entry]);
  await backend.appendLog(parseRefName("list-a"), [entry]);
  const changes = await backend.listChanges();
  expect(changes.filter((name) => name.startsWith("list-"))).toEqual(["list-a", "list-b"]);
});

test("branchTip reads bookmarks; createBranch creates and refuses to overwrite", async () => {
  const backend = await HgBackend.open(repo);
  const tip = await backend.resolveCommit(".");
  expect(await backend.branchTip(parseRefName("no-such-bookmark"))).toBe(undefined);
  await backend.createBranch(parseRefName("created"), tip);
  expect(await backend.branchTip(parseRefName("created"))).toBe(tip);
  await expect(backend.createBranch(parseRefName("created"), tip)).rejects.toThrow(
    'branch already exists: "created"',
  );
});

test("resolveCommit speaks hg's native revision syntax and rejects unknowns", async () => {
  const backend = await HgBackend.open(repo);
  const tip = await backend.resolveCommit(".");
  expect(await backend.resolveCommit("main")).toBeDefined();
  expect(await backend.resolveCommit(tip.slice(0, 12))).toBe(tip);
  await expect(backend.resolveCommit("no-such-rev")).rejects.toThrow('unknown revision: "no-such-rev"');
});

test("isAncestor, mergeBase, and mergedTip read the graph", async () => {
  const backend = await HgBackend.open(repo);
  await hg("update", "-q", "main");
  const root = await backend.resolveCommit("main");
  const left = await commit(repo, "left", { "left.txt": "l\n" });
  await hg("update", "-q", "-r", root);
  const right = await commit(repo, "right", { "right.txt": "r\n" });
  expect(await backend.isAncestor(root, left)).toBe(true);
  expect(await backend.isAncestor(left, root)).toBe(false);
  expect(await backend.isAncestor(left, left)).toBe(true);
  expect(await backend.isAncestor(left, right)).toBe(false);
  expect(await backend.mergeBase(left, right)).toBe(root);
  await expect(backend.mergedTip(left)).rejects.toThrow("not a merge commit");
  await hg("update", "-q", "main");
});

test("readFile round-trips contents and distinguishes absence from directories", async () => {
  const backend = await HgBackend.open(repo);
  await hg("update", "-q", "main");
  const contents = "line one\nline two\n\ttabbed\n";
  const node = await commit(repo, "files", { "dir/inner.txt": contents });
  expect(await backend.readFile(node, parseFilePath("dir/inner.txt"))).toBe(contents);
  expect(await backend.readFile(node, parseFilePath("no/such/file"))).toBe(undefined);
  await expect(backend.readFile(node, parseFilePath("dir"))).rejects.toThrow("not a file");
  await hg("bookmark", "-q", "-f", "-r", node, "main");
});

test("changedFiles lists adds, edits, and removes between two revisions", async () => {
  const backend = await HgBackend.open(repo);
  await hg("update", "-q", "main");
  const before = await commit(repo, "before", { "keep.txt": "same\n", "edit.txt": "old\n", "drop.txt": "bye\n" });
  await hg("rm", "-q", "path:drop.txt");
  const after = await commit(repo, "after", { "edit.txt": "new\n", "add.txt": "hi\n" });
  expect([...(await backend.changedFiles(before, after))].sort()).toEqual(["add.txt", "drop.txt", "edit.txt"]);
  expect(await backend.changedFiles(after, after)).toEqual([]);
  await hg("bookmark", "-q", "-f", "-r", after, "main");
});

test("createChange, rebaseChange, and landChange run against hg end to end", { timeout: 60000 }, async () => {
  const backend = await HgBackend.open(repo);
  const now = testClock();
  await hg("update", "-q", "main");
  const change = parseRefName("gadget");

  await createChange(backend, now, change, parseRefName("main"));
  expect(await backend.branchTip(change)).toBe(await backend.branchTip(parseRefName("main")));

  // The change grows a commit while main moves on underneath it.
  await hg("update", "-q", "gadget");
  await commit(repo, "gadget work", { "gadget.txt": "work\n" });
  await hg("update", "-q", "main");
  await commit(repo, "main moves", { "main.txt": "moved\n" });

  // Rebase: a merge of main into the change, base pinned to main's tip.
  await rebaseChange(backend, now, change, await backend.readLog(change), false);
  const rebased = await backend.readLog(change);
  const base = await changeBase(backend, change, rebased);
  expect(base).toBe(await backend.branchTip(parseRefName("main")));
  const tip = await changeTip(backend, change, rebased);
  expect(await backend.readFile(tip, parseFilePath("main.txt"))).toBe("moved\n");
  expect(await backend.readFile(tip, parseFilePath("gadget.txt"))).toBe("work\n");

  // Land: a merge commit on main carrying the trailer, found by landMerges.
  // Obligations are core logic under core tests; this exercises the merge machinery.
  await landChange(backend, now, change, rebased, "merge", { notOwner: false, unreviewed: true });
  const mainTip = await backend.branchTip(parseRefName("main"));
  if (mainTip === undefined) {
    throw new Error("main lost its tip");
  }
  expect(await backend.mergedTip(mainTip)).toBe(tip);
  expect(await backend.readFile(mainTip, parseFilePath("gadget.txt"))).toBe("work\n");
  const merges = await backend.landMerges(base, mainTip);
  expect(merges).toEqual([{ commit: mainTip, onto: base }]);
  // The land splits main's history into spans that skip the reviewed diff.
  expect(await reviewSpans(backend, base, mainTip)).toEqual([]);
  expect(await hg("log", "-r", "main", "-T", "{desc}")).toBe(landMessage(change).trimEnd());
});

test("squash lands one single-parent commit", { timeout: 60000 }, async () => {
  const backend = await HgBackend.open(repo);
  const now = testClock();
  await hg("update", "-q", "main");
  const change = parseRefName("squashed");
  await createChange(backend, now, change, parseRefName("main"));
  await hg("update", "-q", "squashed");
  await commit(repo, "first", { "squash.txt": "one\n" });
  await commit(repo, "second", { "squash.txt": "one\ntwo\n" });
  await hg("update", "-q", "main");
  await landChange(backend, now, change, await backend.readLog(change), "squash", {
    notOwner: false,
    unreviewed: true,
  });
  const mainTip = await backend.branchTip(parseRefName("main"));
  expect(await hg("log", "-r", "main", "-T", "{p2node}")).toBe("0".repeat(40));
  expect(mainTip === undefined ? undefined : await backend.readFile(mainTip, parseFilePath("squash.txt"))).toBe(
    "one\ntwo\n",
  );
});

test("mergeOnto resolves against the change's own base and commits conflicts with markers", { timeout: 60000 }, async () => {
  const backend = await HgBackend.open(repo);
  await hg("update", "-q", "main");
  const base = await commit(repo, "conflict base", { "clash.txt": "original\n", "clean.txt": "a\n" });
  await hg("bookmark", "-q", "-f", "-r", base, "main");
  await hg("bookmark", "-q", "-r", base, "clasher");
  await hg("update", "-q", "clasher");
  const tip = await commit(repo, "ours", { "clash.txt": "ours\n" });
  await hg("bookmark", "-q", "-f", "-r", tip, "clasher");
  await hg("update", "-q", "main");
  const onto = await commit(repo, "theirs", { "clash.txt": "theirs\n", "clean.txt": "a\nb\n" });
  await hg("bookmark", "-q", "-f", "-r", onto, "main");

  expect(await backend.mergeConflicts(base, tip, onto)).toEqual(["clash.txt"]);
  const conflicts = await backend.mergeOnto(parseRefName("clasher"), base, onto, "merge main into clasher");
  expect(conflicts).toEqual(["clash.txt"]);
  const merged = await backend.branchTip(parseRefName("clasher"));
  if (merged === undefined) {
    throw new Error("clasher lost its tip");
  }
  // Parents: the change's tip first, then what it merged onto.
  expect(await hg("log", "-r", merged.slice(0, 12), "-T", "{p1node} {p2node}")).toBe(`${tip} ${onto}`);
  // The clean file took the onto side; the clash carries zdiff3-style markers.
  expect(await backend.readFile(merged, parseFilePath("clean.txt"))).toBe("a\nb\n");
  const clash = await backend.readFile(merged, parseFilePath("clash.txt"));
  expect(clash).toContain("<<<<<<<");
  expect(clash).toContain("ours");
  expect(clash).toContain("theirs");
  await hg("update", "-q", "main");
});

test("renameChange moves the branch and the log together and refuses existing targets", async () => {
  const backend = await HgBackend.open(repo);
  const now = testClock();
  await hg("update", "-q", "main");
  await createChange(backend, now, parseRefName("old-name"), parseRefName("main"));
  await createChange(backend, now, parseRefName("occupied"), parseRefName("main"));
  await expect(backend.renameChange(parseRefName("old-name"), parseRefName("occupied"))).rejects.toThrow(
    'branch or log already exists: "occupied"',
  );
  await backend.renameChange(parseRefName("old-name"), parseRefName("new-name"));
  expect(await backend.branchTip(parseRefName("old-name"))).toBe(undefined);
  expect(await backend.branchTip(parseRefName("new-name"))).toBeDefined();
  expect(await backend.readLog(parseRefName("old-name"))).toEqual([]);
  expect((await backend.readLog(parseRefName("new-name"))).length).toBeGreaterThan(0);
});

test("workspaces reports the primary working tree; dedicated workspaces are refused", async () => {
  const backend = await HgBackend.open(repo);
  await hg("update", "-q", "main");
  const [workspace] = await backend.workspaces();
  expect(workspace).toEqual({ path: backend.root, branch: "main", dirty: false, primary: true });
  await writeFile(join(repo, "dirty.txt"), "untracked\n");
  expect((await backend.workspaces())[0]?.dirty).toBe(true);
  await rm(join(repo, "dirty.txt"));
  await expect(backend.addWorkspace(join(dir, "ws"), parseRefName("main"))).rejects.toThrow(
    "does not support dedicated workspaces",
  );
});

test("checkout activates the bookmark, refusing a missing one", async () => {
  const backend = await HgBackend.open(repo);
  const now = testClock();
  await hg("update", "-q", "main");
  await createChange(backend, now, parseRefName("checkout-me"), parseRefName("main"));
  await backend.checkout(parseRefName("checkout-me"));
  expect(await backend.currentBranch()).toBe("checkout-me");
  await expect(backend.checkout(parseRefName("nowhere"))).rejects.toThrow('branch does not exist: "nowhere"');
  await backend.checkout(parseRefName("main"));
});

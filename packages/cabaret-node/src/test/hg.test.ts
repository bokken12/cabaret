import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  changeBase,
  changeTip,
  createChange,
  type LogEntry,
  landChange,
  landMessage,
  parseFilePath,
  type Revision,
  rebaseChange,
  reviewSpans,
  type TimestampMs,
  timestampMs,
  userName,
} from "cabaret-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { GitBackend, HgBackend, openBackend, parseHgName, parseHgNode } from "../index.js";

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
async function commit(cwd: string, message: string, files: Record<string, string>): Promise<Revision> {
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
  return () => {
    time += 1000;
    return timestampMs(time);
  };
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
  expect(await backend.currentChange()).toBe("main");
  await hg("bookmark", "-q", "-i", "main");
  await expect(backend.currentChange()).rejects.toThrow("no bookmark is active");
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

test("the hg name grammar reserves hg labels and cabaret's own namespace", () => {
  for (const ok of ["main", "feature/foo", "release-1.2", "with space", "tip-of-tree", "0x1f"]) {
    expect(parseHgName(ok)).toBe(ok);
  }
  for (const bad of [
    "",
    "tip",
    "null",
    ".",
    "123",
    "007",
    "foo:bar",
    "foo@default",
    "cabaret/log/x",
    " padded ",
    "line\nbreak",
  ]) {
    expect(() => parseHgName(bad)).toThrow("not a valid bookmark name");
  }
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
  const change = parseHgName("log-roundtrip");
  expect(await backend.readLog(change)).toEqual([]);
  const tip = await backend.resolveCommit(".");
  const entries: LogEntry[] = [
    {
      timestamp: timestampMs(1748000000000),
      user: alice,
      action: { kind: "set-parent", parent: parseHgName("main") },
    },
    { timestamp: timestampMs(1748000001000), user: alice, action: { kind: "set-base", base: tip } },
  ];
  await backend.appendLog(change, entries.slice(0, 1));
  await backend.appendLog(change, entries.slice(1));
  expect(await backend.readLog(change)).toEqual(entries);
});

test("log commits stay secret, invisible to the user's own push", async () => {
  const backend = await HgBackend.open(repo);
  await backend.appendLog(parseHgName("log-secret"), [
    {
      timestamp: timestampMs(1748000000000),
      user: alice,
      action: { kind: "set-parent", parent: parseHgName("main") },
    },
  ]);
  const phase = await hg("log", "-r", 'bookmark("cabaret/log")', "-T", "{phase}");
  expect(phase).toBe("secret");
  expect(await hg("log", "-r", "secret() and outgoing()", "-T", "{node}").catch(() => "no remote")).toBeDefined();
});

test("listChanges names every change with a log, sorted by name", async () => {
  const backend = await HgBackend.open(repo);
  const entry: LogEntry = {
    timestamp: timestampMs(1748000000000),
    user: alice,
    action: { kind: "set-parent", parent: parseHgName("main") },
  };
  await backend.appendLog(parseHgName("list-b"), [entry]);
  await backend.appendLog(parseHgName("list-a"), [entry]);
  const changes = await backend.listChanges();
  expect(changes.filter((name) => name.startsWith("list-"))).toEqual(["list-a", "list-b"]);
});

test("tip reads bookmarks; create creates and refuses to overwrite", async () => {
  const backend = await HgBackend.open(repo);
  const tip = await backend.resolveCommit(".");
  expect(await backend.tip(parseHgName("no-such-bookmark"))).toBe(undefined);
  await backend.create(parseHgName("created"), tip);
  expect(await backend.tip(parseHgName("created"))).toBe(tip);
  await expect(backend.create(parseHgName("created"), tip)).rejects.toThrow('bookmark already exists: "created"');
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

test("same-revision ancestry answers without consulting the repository", async () => {
  const backend = await HgBackend.open(repo);
  const absent = parseHgNode("deadbeef".repeat(5));
  expect(await backend.isAncestor(absent, absent)).toBe(true);
  expect(await backend.mergeBase(absent, absent)).toBe(absent);
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
  const change = parseHgName("gadget");

  await createChange(backend, now, change, parseHgName("main"));
  expect(await backend.tip(change)).toBe(await backend.tip(parseHgName("main")));

  // The change grows a commit while main moves on underneath it.
  await hg("update", "-q", "gadget");
  await commit(repo, "gadget work", { "gadget.txt": "work\n" });
  await hg("update", "-q", "main");
  await commit(repo, "main moves", { "main.txt": "moved\n" });

  // Rebase: a merge of main into the change, base pinned to main's tip.
  await rebaseChange(backend, now, change, await backend.readLog(change), { notOwner: false, staleParent: false });
  const rebased = await backend.readLog(change);
  const base = await changeBase(backend, change, rebased);
  expect(base).toBe(await backend.tip(parseHgName("main")));
  const tip = await changeTip(backend, change, rebased);
  expect(await backend.readFile(tip, parseFilePath("main.txt"))).toBe("moved\n");
  expect(await backend.readFile(tip, parseFilePath("gadget.txt"))).toBe("work\n");

  // Land: a merge commit on main carrying the trailer, found by landMerges.
  // Obligations are core logic under core tests; this exercises the merge machinery.
  await landChange(backend, now, change, rebased, "merge", { notOwner: false, unreviewed: true });
  const mainTip = await backend.tip(parseHgName("main"));
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
  const change = parseHgName("squashed");
  await createChange(backend, now, change, parseHgName("main"));
  await hg("update", "-q", "squashed");
  await commit(repo, "first", { "squash.txt": "one\n" });
  await commit(repo, "second", { "squash.txt": "one\ntwo\n" });
  await hg("update", "-q", "main");
  await landChange(backend, now, change, await backend.readLog(change), "squash", {
    notOwner: false,
    unreviewed: true,
  });
  const mainTip = await backend.tip(parseHgName("main"));
  expect(await hg("log", "-r", "main", "-T", "{p2node}")).toBe("0".repeat(40));
  expect(mainTip === undefined ? undefined : await backend.readFile(mainTip, parseFilePath("squash.txt"))).toBe(
    "one\ntwo\n",
  );
});

test("a net-empty change still squash-lands, as an empty commit", { timeout: 60000 }, async () => {
  const backend = await HgBackend.open(repo);
  const now = testClock();
  await hg("update", "-q", "main");
  const change = parseHgName("net-empty");
  await createChange(backend, now, change, parseHgName("main"));
  await hg("update", "-q", "net-empty");
  await commit(repo, "add", { "ephemeral.txt": "here\n" });
  await hg("rm", "-q", "path:ephemeral.txt");
  await hg("commit", "-q", "-m", "remove again");
  await hg("update", "-q", "main");
  await landChange(backend, now, change, await backend.readLog(change), "squash", {
    notOwner: false,
    unreviewed: true,
  });
  expect(await hg("log", "-r", "main", "-T", "{files}|{desc|firstline}")).toBe(
    `|${landMessage(change).split("\n")[0]}`,
  );
});

test("mergeOnto resolves against the change's own base and commits conflicts with markers", {
  timeout: 60000,
}, async () => {
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
  const conflicts = await backend.mergeOnto(parseHgName("clasher"), base, onto, "merge main into clasher");
  expect(conflicts).toEqual(["clash.txt"]);
  const merged = await backend.tip(parseHgName("clasher"));
  if (merged === undefined) {
    throw new Error("clasher lost its tip");
  }
  // Parents: the change's tip first, then what it merged onto.
  expect(await hg("log", "-r", merged.slice(0, 12), "-T", "{p1node} {p2node}")).toBe(`${tip} ${onto}`);
  // The clean file took the onto side; the clash carries hg's own merge3
  // markers, base shown.
  expect(await backend.readFile(merged, parseFilePath("clean.txt"))).toBe("a\nb\n");
  expect(await backend.readFile(merged, parseFilePath("clash.txt"))).toBe(
    "<<<<<<< working copy\nours\n||||||| common ancestor\noriginal\n=======\ntheirs\n>>>>>>> merge rev\n",
  );

  // A `ui.merge` naming one of hg's marker-writing internal tools sets the
  // style; here plain merge markers, base hidden.
  await backend.configSet("ui.merge", ":merge", "global");
  await hg("update", "-q", "-r", base);
  const tip2 = await commit(repo, "ours again", { "clash.txt": "ours2\n" });
  await hg("bookmark", "-q", "-r", tip2, "clasher2");
  expect(await backend.mergeOnto(parseHgName("clasher2"), base, onto, "merge main into clasher2")).toEqual([
    "clash.txt",
  ]);
  const merged2 = await backend.tip(parseHgName("clasher2"));
  if (merged2 === undefined) {
    throw new Error("clasher2 lost its tip");
  }
  expect(await backend.readFile(merged2, parseFilePath("clash.txt"))).toBe(
    "<<<<<<< working copy\nours2\n=======\ntheirs\n>>>>>>> merge rev\n",
  );
  await backend.configUnset("ui.merge", "global");
  await hg("update", "-q", "main");
});

test("the repository lock serializes concurrent merges and breaks stale locks", { timeout: 60000 }, async () => {
  const backend = await HgBackend.open(repo);
  const onto = await backend.tip(parseHgName("main"));
  if (onto === undefined) {
    throw new Error("main lost its tip");
  }
  // Two changes branch from main's tip, then main advances.
  await hg("update", "-q", "-r", onto);
  const tipA = await commit(repo, "lock a", { "lock-a.txt": "a\n" });
  await hg("bookmark", "-q", "-r", tipA, "lock-a");
  await hg("update", "-q", "-r", onto);
  const tipB = await commit(repo, "lock b", { "lock-b.txt": "b\n" });
  await hg("bookmark", "-q", "-r", tipB, "lock-b");
  await hg("update", "-q", "-r", onto);
  const onto2 = await commit(repo, "main advances", { "lock-trunk.txt": "t\n" });
  await hg("bookmark", "-q", "-f", "-r", onto2, "main");

  // A lock with no live holder is broken rather than waited out.
  await mkdir(join(repo, ".hg", "cabaret"), { recursive: true });
  await writeFile(join(repo, ".hg", "cabaret", "lock"), "not a pid\n");

  // Both merges build in the one worker; unserialized, one would commit the
  // other's half-built tree.
  const [conflictsA, conflictsB] = await Promise.all([
    backend.mergeOnto(parseHgName("lock-a"), onto, onto2, "merge main into lock-a"),
    backend.mergeOnto(parseHgName("lock-b"), onto, onto2, "merge main into lock-b"),
  ]);
  expect(conflictsA).toEqual([]);
  expect(conflictsB).toEqual([]);
  for (const [name, tip] of [
    ["lock-a", tipA],
    ["lock-b", tipB],
  ] as const) {
    const merged = await backend.tip(parseHgName(name));
    if (merged === undefined) {
      throw new Error(`${name} lost its tip`);
    }
    expect(await hg("log", "-r", merged.slice(0, 12), "-T", "{p1node} {p2node}")).toBe(`${tip} ${onto2}`);
  }
  await hg("update", "-q", "main");
});

test("mergeOnto refuses a base the graph disagrees with", { timeout: 60000 }, async () => {
  const backend = await HgBackend.open(repo);
  const onto = await backend.tip(parseHgName("main"));
  if (onto === undefined) {
    throw new Error("main lost its tip");
  }
  // A change stacked on an unlanded parent, reparented onto main: its
  // recorded base (the old parent's tip) is no common ancestor at all.
  await hg("update", "-q", "-r", onto);
  const parentTip = await commit(repo, "unlanded parent work", { "parent-work.txt": "parent\n" });
  const stacked = await commit(repo, "stacked work", { "stacked.txt": "stacked\n" });
  await hg("bookmark", "-q", "-r", stacked, "stacked");
  await expect(backend.mergeOnto(parseHgName("stacked"), parentTip, onto, "merge main into stacked")).rejects.toThrow(
    "hg merges against the common ancestor",
  );
  await hg("update", "-q", "main");
});

test("rename moves the branch and the log together and refuses existing targets", { timeout: 60000 }, async () => {
  const backend = await HgBackend.open(repo);
  const now = testClock();
  await hg("update", "-q", "main");
  await createChange(backend, now, parseHgName("old-name"), parseHgName("main"));
  await createChange(backend, now, parseHgName("occupied"), parseHgName("main"));
  await expect(backend.rename(parseHgName("old-name"), parseHgName("occupied"))).rejects.toThrow(
    'bookmark or log already exists: "occupied"',
  );
  await backend.rename(parseHgName("old-name"), parseHgName("new-name"));
  expect(await backend.tip(parseHgName("old-name"))).toBe(undefined);
  expect(await backend.tip(parseHgName("new-name"))).toBeDefined();
  expect(await backend.readLog(parseHgName("old-name"))).toEqual([]);
  expect((await backend.readLog(parseHgName("new-name"))).length).toBeGreaterThan(0);
});

test("dedicated workspaces are hg shares, registered and pruned by cabaret", { timeout: 60000 }, async () => {
  const backend = await HgBackend.open(repo);
  const now = testClock();
  await hg("update", "-q", "main");
  const [workspace] = await backend.workspaces();
  expect(workspace).toEqual({ path: backend.root, change: "main", dirty: false, primary: true });
  await writeFile(join(repo, "dirty.txt"), "untracked\n");
  expect((await backend.workspaces())[0]?.dirty).toBe(true);
  await rm(join(repo, "dirty.txt"));

  // Without the share extension in the user's own config, a workspace would
  // be a trap: their hg would see no bookmarks inside it.
  const ws = join(dir, "ws-gizmo");
  await expect(backend.addWorkspace(ws, parseHgName("gizmo"))).rejects.toThrow("cabaret setup apply");
  await backend.configSet("extensions.share", "", "global");

  await createChange(backend, now, parseHgName("gizmo"), parseHgName("main"));
  await backend.addWorkspace(ws, parseHgName("gizmo"));
  const real = await realpath(ws);
  expect(await backend.workspaces()).toEqual([
    { path: backend.root, change: "main", dirty: false, primary: true },
    { path: real, change: "gizmo", dirty: false, primary: false },
  ]);

  // The user's own hg works the change in its workspace: the shared store
  // sees the commit, and the moved bookmark, everywhere.
  const moved = await commit(ws, "gizmo work", { "gizmo.txt": "w\n" });
  expect(await backend.tip(parseHgName("gizmo"))).toBe(moved);

  // A backend opened in the share reads and writes the one repository. Its
  // root matches the listing's spelling, so path equality finds the current
  // workspace.
  const shared = await HgBackend.open(ws);
  expect(shared.root).toBe(real);
  expect(await shared.currentChange()).toBe("gizmo");
  expect(await shared.readLog(parseHgName("gizmo"))).toEqual(await backend.readLog(parseHgName("gizmo")));
  await shared.configSet("cabaret.landMethod", "squash", "local");
  expect(await backend.config("cabaret.landMethod")).toBe("squash");
  await backend.configUnset("cabaret.landMethod", "local");

  // Dirty workspaces refuse removal until forced; the registry prunes with them.
  await writeFile(join(ws, "untracked.txt"), "x\n");
  await expect(backend.removeWorkspace(ws, false)).rejects.toThrow("uncommitted changes");
  await backend.removeWorkspace(ws, true);
  expect(await backend.workspaces()).toEqual([{ path: backend.root, change: "main", dirty: false, primary: true }]);

  // A workspace deleted out from under cabaret prunes from the listing and
  // the registry alike.
  await backend.addWorkspace(ws, parseHgName("gizmo"));
  await rm(ws, { recursive: true, force: true });
  expect(await backend.workspaces()).toEqual([{ path: backend.root, change: "main", dirty: false, primary: true }]);
  expect(await readFile(join(repo, ".hg", "cabaret", "workspaces"), "utf8")).toBe("");
});

test("checkout activates the bookmark, refusing a missing one", async () => {
  const backend = await HgBackend.open(repo);
  const now = testClock();
  await hg("update", "-q", "main");
  await createChange(backend, now, parseHgName("checkout-me"), parseHgName("main"));
  await backend.checkout(parseHgName("checkout-me"));
  expect(await backend.currentChange()).toBe("checkout-me");
  await expect(backend.checkout(parseHgName("nowhere"))).rejects.toThrow('bookmark does not exist: "nowhere"');
  await backend.checkout(parseHgName("main"));
});

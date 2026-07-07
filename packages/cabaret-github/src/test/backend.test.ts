import {
  formatLogEntry,
  type LogEntry,
  parseCommitHash,
  parseFilePath,
  parseRefName,
  timestampMs,
  UserError,
  userName,
} from "cabaret-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { GitHubBackend } from "../backend.js";
import { githubClient } from "../client.js";
import { stubGitHub } from "./stub.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const API = "https://api.github.com";
const REPOS = `${API}/repos/test-org/widgets`;

// Distinct, valid hashes for fixtures: sha(N) is N repeated.
function sha(digit: string) {
  return parseCommitHash(digit.repeat(40));
}

function backend(): GitHubBackend {
  return new GitHubBackend(githubClient("token-123", { throttled: false }), { owner: "test-org", repo: "widgets" });
}

/** A Git-database commit response. */
function commitJson(commit: string, parents: readonly string[], message = "work", tree = "f".repeat(40)) {
  return { sha: commit, message, tree: { sha: tree }, parents: parents.map((parent) => ({ sha: parent })) };
}

describe("currentUser", () => {
  test("is the token account's public profile email, looked up once", async () => {
    const calls = stubGitHub({
      [`GET ${API}/user`]: { json: { login: "alice", email: "alice@example.com" } },
    });
    const github = backend();
    expect(await github.currentUser()).toBe("alice@example.com");
    expect(await github.currentUser()).toBe("alice@example.com");
    expect(calls).toHaveLength(1);
  });

  test("falls back to the noreply identity when no email is public", async () => {
    stubGitHub({
      [`GET ${API}/user`]: { json: { login: "bob", email: null } },
    });
    expect(await backend().currentUser()).toBe("bob@users.noreply.github.com");
  });

  test("a failed lookup is not cached: the next call asks again", async () => {
    stubGitHub({
      [`GET ${API}/user`]: [
        { status: 401, json: { message: "Bad credentials" } },
        { json: { login: "carol", email: "carol@example.com" } },
      ],
    });
    const github = backend();
    await expect(github.currentUser()).rejects.toMatchObject({ status: 401 });
    expect(await github.currentUser()).toBe("carol@example.com");
  });
});

describe("resolveCommit", () => {
  test("resolves branch names and hashes through the commits API", async () => {
    stubGitHub({
      [`GET ${REPOS}/commits/feature`]: { json: { sha: sha("1") } },
    });
    expect(await backend().resolveCommit("feature")).toBe(sha("1"));
  });

  test("resolves refs/ names through the ref API", async () => {
    stubGitHub({
      [`GET ${REPOS}/git/ref/heads%2Ffeature`]: { json: { object: { type: "commit", sha: sha("2") } } },
    });
    expect(await backend().resolveCommit("refs/heads/feature")).toBe(sha("2"));
  });

  test("^2 selects a merge's second parent", async () => {
    stubGitHub({
      [`GET ${REPOS}/commits/${sha("3")}`]: { json: { sha: sha("3") } },
      [`GET ${REPOS}/git/commits/${sha("3")}`]: { json: commitJson(sha("3"), [sha("4"), sha("5")]) },
    });
    expect(await backend().resolveCommit(`${sha("3")}^2`)).toBe(sha("5"));
  });

  test("~2 walks two first parents", async () => {
    stubGitHub({
      [`GET ${REPOS}/commits/${sha("3")}`]: { json: { sha: sha("3") } },
      [`GET ${REPOS}/git/commits/${sha("3")}`]: { json: commitJson(sha("3"), [sha("4")]) },
      [`GET ${REPOS}/git/commits/${sha("4")}`]: { json: commitJson(sha("4"), [sha("5")]) },
    });
    expect(await backend().resolveCommit(`${sha("3")}~2`)).toBe(sha("5"));
  });

  test("~1^2 composes: first parent, then that merge's second parent", async () => {
    stubGitHub({
      [`GET ${REPOS}/commits/${sha("3")}`]: { json: { sha: sha("3") } },
      [`GET ${REPOS}/git/commits/${sha("3")}`]: { json: commitJson(sha("3"), [sha("4")]) },
      [`GET ${REPOS}/git/commits/${sha("4")}`]: { json: commitJson(sha("4"), [sha("5"), sha("6")]) },
    });
    expect(await backend().resolveCommit(`${sha("3")}~1^2`)).toBe(sha("6"));
  });

  test("an unknown revision is a UserError", async () => {
    stubGitHub({
      [`GET ${REPOS}/commits/vanished`]: { status: 404, json: { message: "Not Found" } },
    });
    await expect(backend().resolveCommit("vanished")).rejects.toThrow(UserError);
  });

  test("a parent past the end is a UserError", async () => {
    stubGitHub({
      [`GET ${REPOS}/commits/${sha("3")}`]: { json: { sha: sha("3") } },
      [`GET ${REPOS}/git/commits/${sha("3")}`]: { json: commitJson(sha("3"), [sha("4")]) },
    });
    await expect(backend().resolveCommit(`${sha("3")}^2`)).rejects.toThrow(UserError);
  });
});

describe("branchTip", () => {
  test("is the branch's commit", async () => {
    stubGitHub({
      [`GET ${REPOS}/git/ref/heads%2Fadd-tables`]: { json: { object: { type: "commit", sha: sha("6") } } },
    });
    expect(await backend().branchTip(parseRefName("add-tables"))).toBe(sha("6"));
  });

  test("is undefined for a missing branch", async () => {
    stubGitHub({
      [`GET ${REPOS}/git/ref/heads%2Fgone`]: { status: 404, json: { message: "Not Found" } },
    });
    expect(await backend().branchTip(parseRefName("gone"))).toBeUndefined();
  });
});

describe("comparisons", () => {
  test("mergeBase reads the comparison's merge base", async () => {
    stubGitHub({
      [`GET ${REPOS}/compare/main...feature?per_page=1`]: {
        json: { status: "diverged", merge_base_commit: { sha: sha("7") }, files: [] },
      },
    });
    expect(await backend().mergeBase(parseRefName("main"), parseRefName("feature"))).toBe(sha("7"));
  });

  test.each([
    ["ahead", true],
    ["identical", true],
    ["behind", false],
    ["diverged", false],
  ] as const)("isAncestor maps status %s to %s", async (status, expected) => {
    stubGitHub({
      [`GET ${REPOS}/compare/${sha("1")}...${sha("2")}?per_page=1`]: {
        json: { status, merge_base_commit: { sha: sha("1") }, files: [] },
      },
    });
    expect(await backend().isAncestor(sha("1"), sha("2"))).toBe(expected);
  });
});

describe("landMerges", () => {
  const base = sha("a");
  const c1 = sha("b");
  const land = sha("c");
  const cherry = sha("d");
  const tip = sha("e");
  const landMessage = "Land child\n\nCabaret-Landed: child\n";

  /** One commit of a compare listing. */
  function listed(commit: string, parents: readonly string[], message = "work") {
    return { sha: commit, commit: { message }, parents: parents.map((parent) => ({ sha: parent })) };
  }

  /** The compare listing of base..tip, one page. */
  function comparePage(commits: readonly ReturnType<typeof listed>[]) {
    return {
      [`GET ${REPOS}/compare/${base}...${tip}?per_page=100&page=1`]: {
        json: { total_commits: commits.length, commits },
      },
    };
  }

  test("finds trailer-bearing merges on the first-parent chain, oldest first", async () => {
    const calls = stubGitHub(
      // tip is a cherry-pick of the land merge: same message, one parent.
      comparePage([
        listed(c1, [base], "plain work"),
        listed(land, [c1, sha("9")], landMessage),
        listed(cherry, [land], landMessage),
        listed(tip, [cherry], landMessage),
      ]),
    );
    expect(await backend().landMerges(base, tip)).toEqual([{ commit: land, onto: c1 }]);
    expect(calls).toHaveLength(1);
  });

  test("stops where the first-parent chain leaves base..tip, as when the parent was merged in", async () => {
    // tip merges base in rather than descending from it: base is on tip's
    // second-parent line, and the first-parent chain runs past it to older
    // history outside the listing.
    stubGitHub(comparePage([listed(tip, [c1, base], landMessage)]));
    expect(await backend().landMerges(base, tip)).toEqual([{ commit: tip, onto: c1 }]);
  });

  test("pages a listing longer than one page and caches the answer", async () => {
    // 150 commits: c(0) is the land merge, everything above is plain work.
    const chain = Array.from({ length: 150 }, (_, i) => sha("0").slice(0, 37) + String(i).padStart(3, "0"));
    const commits = chain.map((commit, i) =>
      listed(
        commit,
        [i === 0 ? base : (chain[i - 1] as string), ...(i === 0 ? [sha("9")] : [])],
        i === 0 ? landMessage : "work",
      ),
    );
    const calls = stubGitHub({
      [`GET ${REPOS}/compare/${base}...${chain[149]}?per_page=100&page=1`]: {
        json: { total_commits: 150, commits: commits.slice(0, 100) },
      },
      [`GET ${REPOS}/compare/${base}...${chain[149]}?per_page=100&page=2`]: {
        json: { total_commits: 150, commits: commits.slice(100) },
      },
    });
    const github = backend();
    const merges = [{ commit: chain[0], onto: base }];
    expect(await github.landMerges(base, parseCommitHash(chain[149] as string))).toEqual(merges);
    expect(await github.landMerges(base, parseCommitHash(chain[149] as string))).toEqual(merges);
    expect(calls).toHaveLength(2);
  });
});

describe("files", () => {
  test("readFile returns the raw contents at a commit", async () => {
    stubGitHub({
      [`GET ${REPOS}/contents/src%2Fapp.ts?ref=${sha("1")}`]: { json: "export const x = 1;\n" },
    });
    expect(await backend().readFile(sha("1"), parseFilePath("src/app.ts"))).toBe("export const x = 1;\n");
  });

  test("hash-keyed queries cache: repeat asks cost no further requests", async () => {
    const calls = stubGitHub({
      [`GET ${REPOS}/contents/a.ts?ref=${sha("1")}`]: { json: "one\n" },
      [`GET ${REPOS}/compare/${sha("1")}...${sha("2")}?per_page=1`]: {
        json: { status: "ahead", merge_base_commit: { sha: sha("1") } },
      },
    });
    const github = backend();
    expect(await github.readFile(sha("1"), parseFilePath("a.ts"))).toBe("one\n");
    expect(await github.readFile(sha("1"), parseFilePath("a.ts"))).toBe("one\n");
    expect(await github.isAncestor(sha("1"), sha("2"))).toBe(true);
    expect(await github.isAncestor(sha("1"), sha("2"))).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test("a failed query is not cached: the next ask goes back to the API", async () => {
    const calls = stubGitHub({
      [`GET ${REPOS}/contents/a.ts?ref=${sha("1")}`]: [
        { status: 401, json: { message: "Bad credentials" } },
        { json: "one\n" },
      ],
    });
    const github = backend();
    await expect(github.readFile(sha("1"), parseFilePath("a.ts"))).rejects.toMatchObject({ status: 401 });
    expect(await github.readFile(sha("1"), parseFilePath("a.ts"))).toBe("one\n");
    expect(calls).toHaveLength(2);
  });

  test("readFile is undefined for a path absent at the commit", async () => {
    stubGitHub({
      [`GET ${REPOS}/contents/missing.ts?ref=${sha("1")}`]: { status: 404, json: { message: "Not Found" } },
    });
    expect(await backend().readFile(sha("1"), parseFilePath("missing.ts"))).toBeUndefined();
  });

  test("changedFiles diffs the two trees: edits, moves, chmods, and no submodules", async () => {
    stubGitHub({
      [`GET ${REPOS}/git/commits/${sha("1")}`]: { json: commitJson(sha("1"), [], "base", "1a".repeat(20)) },
      [`GET ${REPOS}/git/commits/${sha("2")}`]: { json: commitJson(sha("2"), [sha("1")], "tip", "2b".repeat(20)) },
      [`GET ${REPOS}/git/trees/${"1a".repeat(20)}?recursive=1`]: {
        json: {
          truncated: false,
          tree: [
            { path: "docs", mode: "040000", type: "tree", sha: sha("3") },
            { path: "docs/old-name.md", mode: "100644", type: "blob", sha: sha("4") },
            { path: "run.sh", mode: "100644", type: "blob", sha: sha("5") },
            { path: "same.txt", mode: "100644", type: "blob", sha: sha("6") },
            { path: "vendored", mode: "160000", type: "commit", sha: sha("7") },
            { path: "zebra.ts", mode: "100644", type: "blob", sha: sha("8") },
          ],
        },
      },
      [`GET ${REPOS}/git/trees/${"2b".repeat(20)}?recursive=1`]: {
        json: {
          truncated: false,
          tree: [
            { path: "docs", mode: "040000", type: "tree", sha: sha("3") },
            // The move: old path gone, same blob at a new path.
            { path: "docs/new-name.md", mode: "100644", type: "blob", sha: sha("4") },
            // The chmod: same blob, executable now.
            { path: "run.sh", mode: "100755", type: "blob", sha: sha("5") },
            { path: "same.txt", mode: "100644", type: "blob", sha: sha("6") },
            // The submodule bump: never a file, never listed.
            { path: "vendored", mode: "160000", type: "commit", sha: sha("9") },
            { path: "zebra.ts", mode: "100644", type: "blob", sha: sha("a") },
          ],
        },
      },
    });
    expect(await backend().changedFiles(sha("1"), sha("2"))).toEqual([
      "docs/new-name.md",
      "docs/old-name.md",
      "run.sh",
      "zebra.ts",
    ]);
  });

  test("changedFiles refuses a truncated tree listing rather than misreporting", async () => {
    stubGitHub({
      [`GET ${REPOS}/git/commits/${sha("1")}`]: { json: commitJson(sha("1"), [], "base", "1a".repeat(20)) },
      [`GET ${REPOS}/git/commits/${sha("2")}`]: { json: commitJson(sha("2"), [], "tip", "2b".repeat(20)) },
      [`GET ${REPOS}/git/trees/${"1a".repeat(20)}?recursive=1`]: { json: { truncated: true, tree: [] } },
      [`GET ${REPOS}/git/trees/${"2b".repeat(20)}?recursive=1`]: { json: { truncated: false, tree: [] } },
    });
    await expect(backend().changedFiles(sha("1"), sha("2"))).rejects.toThrow("tree too large");
  });
});

describe("logs", () => {
  const entry: LogEntry = {
    timestamp: timestampMs(1700000000000),
    user: userName("alice@example.com"),
    action: { kind: "comment", text: "looks good" },
  };
  const other: LogEntry = {
    timestamp: timestampMs(1700000001000),
    user: userName("bob@example.com"),
    action: { kind: "forget", file: parseFilePath("src/app.ts") },
  };

  test("listChanges strips the log namespace and sorts", async () => {
    stubGitHub({
      [`GET ${REPOS}/git/matching-refs/cabaret%2Flog%2F?per_page=100`]: {
        json: [{ ref: "refs/cabaret/log/zeta" }, { ref: "refs/cabaret/log/alpha" }],
      },
    });
    expect(await backend().listChanges()).toEqual(["alpha", "zeta"]);
  });

  test("readLog is empty for a change with no log ref", async () => {
    stubGitHub({
      [`GET ${REPOS}/git/ref/cabaret%2Flog%2Funknown`]: { status: 404, json: { message: "Not Found" } },
    });
    expect(await backend().readLog(parseRefName("unknown"))).toEqual([]);
  });

  test("readLog parses the log blob at the ref's tip", async () => {
    stubGitHub({
      [`GET ${REPOS}/git/ref/cabaret%2Flog%2Fadd-tables`]: { json: { object: { type: "commit", sha: sha("8") } } },
      [`GET ${REPOS}/contents/log?ref=${sha("8")}`]: { json: formatLogEntry(entry) },
    });
    expect(await backend().readLog(parseRefName("add-tables"))).toEqual([entry]);
  });

  test("appendLog creates the log when none exists", async () => {
    const calls = stubGitHub({
      [`GET ${REPOS}/git/ref/cabaret%2Flog%2Ffresh`]: { status: 404, json: { message: "Not Found" } },
      [`POST ${REPOS}/git/blobs`]: { status: 201, json: { sha: "b".repeat(40) } },
      [`POST ${REPOS}/git/trees`]: { status: 201, json: { sha: "d".repeat(40) } },
      [`POST ${REPOS}/git/commits`]: { status: 201, json: { sha: sha("9") } },
      [`POST ${REPOS}/git/refs`]: { status: 201, json: {} },
    });
    await backend().appendLog(parseRefName("fresh"), [entry]);
    const blob = calls.find(({ url, method }) => method === "POST" && url.endsWith("/git/blobs"));
    expect(JSON.parse(blob?.body ?? "{}")).toEqual({ content: formatLogEntry(entry), encoding: "utf-8" });
    const created = calls.find(({ url, method }) => method === "POST" && url.endsWith("/git/refs"));
    expect(JSON.parse(created?.body ?? "{}")).toEqual({ ref: "refs/cabaret/log/fresh", sha: sha("9") });
  });

  test("a lost compare-and-swap re-reads the moved log and retries", async () => {
    const calls = stubGitHub({
      [`GET ${REPOS}/git/ref/cabaret%2Flog%2Fbusy`]: [
        { json: { object: { type: "commit", sha: sha("1") } } },
        { json: { object: { type: "commit", sha: sha("2") } } },
      ],
      [`GET ${REPOS}/contents/log?ref=${sha("1")}`]: { json: formatLogEntry(entry) },
      // The concurrent append that won the first swap added `other`.
      [`GET ${REPOS}/contents/log?ref=${sha("2")}`]: { json: formatLogEntry(entry) + formatLogEntry(other) },
      [`POST ${REPOS}/git/blobs`]: { status: 201, json: { sha: "b".repeat(40) } },
      [`POST ${REPOS}/git/trees`]: { status: 201, json: { sha: "d".repeat(40) } },
      [`POST ${REPOS}/git/commits`]: [
        { status: 201, json: { sha: sha("3") } },
        { status: 201, json: { sha: sha("4") } },
      ],
      [`PATCH ${REPOS}/git/refs/cabaret%2Flog%2Fbusy`]: [
        { status: 422, json: { message: "Update is not a fast forward" } },
        { json: {} },
      ],
    });
    const appended: LogEntry = {
      timestamp: timestampMs(1700000002000),
      user: userName("alice@example.com"),
      action: { kind: "comment", text: "second pass" },
    };
    await backend().appendLog(parseRefName("busy"), [appended]);
    const blobs = calls
      .filter(({ url, method }) => method === "POST" && url.endsWith("/git/blobs"))
      .map(({ body }) => (JSON.parse(body ?? "{}") as { content: string }).content);
    // The retry rebuilt the blob on the moved tip: everyone's entries survive.
    expect(blobs).toEqual([
      formatLogEntry(entry) + formatLogEntry(appended),
      formatLogEntry(entry) + formatLogEntry(other) + formatLogEntry(appended),
    ]);
    const patches = calls.filter(({ method }) => method === "PATCH");
    expect(patches.map(({ body }) => JSON.parse(body ?? "{}"))).toEqual([
      { sha: sha("3"), force: false },
      { sha: sha("4"), force: false },
    ]);
  });

  test("appends issued while one is in flight batch into a single commit", async () => {
    const calls = stubGitHub({
      [`GET ${REPOS}/git/ref/cabaret%2Flog%2Fbusy`]: [
        { json: { object: { type: "commit", sha: sha("1") } } },
        { json: { object: { type: "commit", sha: sha("3") } } },
      ],
      [`GET ${REPOS}/contents/log?ref=${sha("1")}`]: { json: formatLogEntry(entry) },
      [`GET ${REPOS}/contents/log?ref=${sha("3")}`]: { json: formatLogEntry(entry) + formatLogEntry(other) },
      [`POST ${REPOS}/git/blobs`]: { status: 201, json: { sha: "b".repeat(40) } },
      [`POST ${REPOS}/git/trees`]: { status: 201, json: { sha: "d".repeat(40) } },
      [`POST ${REPOS}/git/commits`]: [
        { status: 201, json: { sha: sha("3") } },
        { status: 201, json: { sha: sha("4") } },
      ],
      [`PATCH ${REPOS}/git/refs/cabaret%2Flog%2Fbusy`]: { json: {} },
    });
    const at = (offset: number, text: string): LogEntry => ({
      timestamp: timestampMs(1700000002000 + offset),
      user: userName("alice@example.com"),
      action: { kind: "comment", text },
    });
    const github = backend();
    const change = parseRefName("busy");
    // `other` seals a batch first; the two marks that follow while it is in
    // flight ride the next commit together.
    const first = github.appendLog(change, [other]);
    await Promise.resolve();
    const second = github.appendLog(change, [at(1, "mark a")]);
    const third = github.appendLog(change, [at(2, "mark b")]);
    await Promise.all([first, second, third]);
    const blobs = calls
      .filter(({ url, method }) => method === "POST" && url.endsWith("/git/blobs"))
      .map(({ body }) => (JSON.parse(body ?? "{}") as { content: string }).content);
    expect(blobs).toEqual([
      formatLogEntry(entry) + formatLogEntry(other),
      formatLogEntry(entry) + formatLogEntry(other) + formatLogEntry(at(1, "mark a")) + formatLogEntry(at(2, "mark b")),
    ]);
    expect(calls.filter(({ method }) => method === "PATCH")).toHaveLength(2);
  });

  test("a failed append rejects only its own batch", async () => {
    const calls = stubGitHub({
      [`GET ${REPOS}/git/ref/cabaret%2Flog%2Fbusy`]: [
        { status: 401, json: { message: "Bad credentials" } },
        { json: { object: { type: "commit", sha: sha("1") } } },
      ],
      [`GET ${REPOS}/contents/log?ref=${sha("1")}`]: { json: formatLogEntry(entry) },
      [`POST ${REPOS}/git/blobs`]: { status: 201, json: { sha: "b".repeat(40) } },
      [`POST ${REPOS}/git/trees`]: { status: 201, json: { sha: "d".repeat(40) } },
      [`POST ${REPOS}/git/commits`]: { status: 201, json: { sha: sha("3") } },
      [`PATCH ${REPOS}/git/refs/cabaret%2Flog%2Fbusy`]: { json: {} },
    });
    const github = backend();
    const change = parseRefName("busy");
    const first = github.appendLog(change, [other]);
    await Promise.resolve();
    const second = github.appendLog(change, [
      {
        timestamp: timestampMs(1700000002000),
        user: userName("alice@example.com"),
        action: { kind: "comment", text: "after" },
      },
    ]);
    await expect(first).rejects.toMatchObject({ status: 401 });
    await second;
    expect(calls.filter(({ method }) => method === "PATCH")).toHaveLength(1);
  });

  test("appendLog with no entries stays offline", async () => {
    const calls = stubGitHub({});
    await backend().appendLog(parseRefName("idle"), []);
    expect(calls).toEqual([]);
  });
});

describe("merge", () => {
  test("commits the tip's tree over both parents and fast-forwards the branch", async () => {
    const calls = stubGitHub({
      [`GET ${REPOS}/git/commits/${sha("2")}`]: { json: commitJson(sha("2"), [sha("1")], "child tip", "e".repeat(40)) },
      [`POST ${REPOS}/git/commits`]: { status: 201, json: { sha: sha("5") } },
      [`PATCH ${REPOS}/git/refs/heads%2Fmain`]: { json: {} },
    });
    const merge = await backend().merge(parseRefName("main"), sha("1"), sha("2"), "Land child\n");
    expect(merge).toBe(sha("5"));
    const commit = calls.find(({ method, url }) => method === "POST" && url.endsWith("/git/commits"));
    expect(JSON.parse(commit?.body ?? "{}")).toEqual({
      message: "Land child\n",
      tree: "e".repeat(40),
      parents: [sha("1"), sha("2")],
    });
    expect(JSON.parse(calls.find(({ method }) => method === "PATCH")?.body ?? "{}")).toEqual({
      sha: sha("5"),
      force: false,
    });
  });
});

describe("operations needing a local repository", () => {
  test.each([
    ["currentBranch", () => backend().currentBranch()],
    ["renameChange", () => backend().renameChange()],
    ["rebaseOnto", () => backend().rebaseOnto()],
  ])("%s is a UserError", async (_name, call) => {
    stubGitHub({});
    await expect(call()).rejects.toThrow(UserError);
  });

  test("the sync operations are no-ops with nothing to reconcile", async () => {
    const calls = stubGitHub({
      [`GET ${REPOS}/git/matching-refs/cabaret%2Flog%2F?per_page=100`]: { json: [{ ref: "refs/cabaret/log/only" }] },
    });
    const github = backend();
    await github.syncLog();
    await github.pushBranch();
    await github.fetchBranch();
    expect(calls).toEqual([]);
    expect(await github.syncLogs()).toEqual(["only"]);
  });
});

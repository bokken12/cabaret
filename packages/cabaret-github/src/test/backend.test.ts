import {
  formatLogEntry,
  type LogEntry,
  landMessage,
  parseBranchName,
  parseCommitHash,
  parseFilePath,
  timestampMs,
  UserError,
  userName,
} from "cabaret-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { GitHubBackend } from "../backend.js";
import { githubClient } from "../client.js";
import { type Route, stubGitHub } from "./stub.js";

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

/** One swept change: its log ref's tip and text, and its branch tip (null for a branch-less log). */
interface SweptChange {
  readonly change: string;
  readonly logTip: string;
  readonly log: string;
  readonly head: string | null;
  /** Serve the log blob truncated, forcing the raw reread. */
  readonly truncated?: boolean;
}

/** Routes answering `epochs` sweeps of `changes`: a log-ref listing each, plus a lookup batch when changes exist. */
function sweepRoutes(changes: readonly SweptChange[], epochs = 1): Readonly<Record<string, readonly Route[]>> {
  const listing: Route = {
    json: changes.map(({ change, logTip }) => ({ ref: `refs/cabaret/log/${change}`, object: { sha: logTip } })),
  };
  const batch: Route = {
    json: {
      data: {
        repository: Object.fromEntries(
          changes.flatMap(({ log, head, truncated = false }, i) => [
            [`l${i}`, { file: { object: { isTruncated: truncated, text: truncated ? null : log } } }],
            [`h${i}`, head === null ? null : { target: { oid: head } }],
          ]),
        ),
      },
    },
  };
  return {
    [`GET ${REPOS}/git/matching-refs/cabaret%2Flog%2F?per_page=100`]: Array.from({ length: epochs }, () => listing),
    ...(changes.length === 0 ? {} : { [`POST ${API}/graphql`]: Array.from({ length: epochs }, () => batch) }),
  };
}

/** One commit of a compare or commits listing. */
function listed(commit: string, parents: readonly string[], message = "work") {
  return { sha: commit, commit: { message }, parents: parents.map((parent) => ({ sha: parent })) };
}

/** One batched commit-object alias value; route null for a commit the repository lacks. */
function commitNode(commit: string, parents: readonly string[], message = "work", tree = "f".repeat(40)) {
  return {
    oid: commit,
    message,
    tree: { oid: tree },
    parents: { totalCount: parents.length, nodes: parents.map((oid) => ({ oid })) },
  };
}

/** One flush of coalesced asks: alias values in ask order, `c` for commits, `b` for blobs. */
function batched(prefix: "b" | "c", nodes: readonly unknown[]): Route {
  return { json: { data: { repository: Object.fromEntries(nodes.map((node, i) => [`${prefix}${i}`, node])) } } };
}

/** A batched blob answer carrying `text`. */
function blobNode(text: string) {
  return { file: { object: { isTruncated: false, text } } };
}

describe("currentUser", () => {
  test("is the token account under the github: scheme, looked up once", async () => {
    const calls = stubGitHub({
      [`GET ${API}/user`]: { json: { login: "alice", email: "alice@example.com" } },
    });
    const github = backend();
    expect(await github.currentUser()).toBe("github:alice");
    expect(await github.currentUser()).toBe("github:alice");
    expect(calls).toHaveLength(1);
  });

  test("a failed lookup is not cached: the next call asks again", async () => {
    stubGitHub({
      [`GET ${API}/user`]: [
        { status: 401, json: { message: "Bad credentials" } },
        { json: { login: "carol", email: null } },
      ],
    });
    const github = backend();
    await expect(github.currentUser()).rejects.toMatchObject({ status: 401 });
    expect(await github.currentUser()).toBe("github:carol");
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
      [`POST ${API}/graphql`]: batched("c", [commitNode(sha("3"), [sha("4"), sha("5")])]),
    });
    expect(await backend().resolveCommit(`${sha("3")}^2`)).toBe(sha("5"));
  });

  test("~2 walks two first parents", async () => {
    stubGitHub({
      [`GET ${REPOS}/commits/${sha("3")}`]: { json: { sha: sha("3") } },
      [`POST ${API}/graphql`]: [
        batched("c", [commitNode(sha("3"), [sha("4")])]),
        batched("c", [commitNode(sha("4"), [sha("5")])]),
      ],
    });
    expect(await backend().resolveCommit(`${sha("3")}~2`)).toBe(sha("5"));
  });

  test("~1^2 composes: first parent, then that merge's second parent", async () => {
    stubGitHub({
      [`GET ${REPOS}/commits/${sha("3")}`]: { json: { sha: sha("3") } },
      [`POST ${API}/graphql`]: [
        batched("c", [commitNode(sha("3"), [sha("4")])]),
        batched("c", [commitNode(sha("4"), [sha("5"), sha("6")])]),
      ],
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
      [`POST ${API}/graphql`]: batched("c", [commitNode(sha("3"), [sha("4")])]),
    });
    await expect(backend().resolveCommit(`${sha("3")}^2`)).rejects.toThrow(UserError);
  });
});

describe("tips", () => {
  test("tip and originTip answer from one sweep: this backend's branches are origin's", async () => {
    const calls = stubGitHub(sweepRoutes([{ change: "add-tables", logTip: sha("8"), log: "", head: sha("6") }]));
    const github = backend();
    expect(await github.tip(parseBranchName("add-tables"))).toBe(sha("6"));
    expect(await github.originTip(parseBranchName("add-tables"))).toBe(sha("6"));
    expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET ${REPOS}/git/matching-refs/cabaret%2Flog%2F?per_page=100`,
      `POST ${API}/graphql`,
    ]);
  });

  test("a branch outside the sweep reads through live, once per epoch", async () => {
    const calls = stubGitHub({
      ...sweepRoutes([]),
      [`GET ${REPOS}/git/ref/heads%2Fmain`]: { json: { object: { type: "commit", sha: sha("6") } } },
    });
    const github = backend();
    expect(await github.tip(parseBranchName("main"))).toBe(sha("6"));
    expect(await github.tip(parseBranchName("main"))).toBe(sha("6"));
    expect(calls.filter(({ url }) => url.includes("/git/ref/"))).toHaveLength(1);
  });

  test("tip is undefined for a missing branch", async () => {
    stubGitHub({
      ...sweepRoutes([]),
      [`GET ${REPOS}/git/ref/heads%2Fgone`]: { status: 404, json: { message: "Not Found" } },
    });
    expect(await backend().tip(parseBranchName("gone"))).toBeUndefined();
  });

  test("originFetched is the epoch's sweep; fetchOrigin starts a fresh one", async () => {
    const calls = stubGitHub(sweepRoutes([], 2));
    // Only the clock: octokit schedules its requests on real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1700000005000);
    try {
      const github = backend();
      expect(await github.originFetched()).toBe(1700000005000);
      vi.setSystemTime(1700000009000);
      expect(await github.originFetched()).toBe(1700000005000);
      await github.fetchOrigin();
      expect(await github.originFetched()).toBe(1700000009000);
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a failed sweep is not held: the next read sweeps again", async () => {
    const good = sweepRoutes([{ change: "add-tables", logTip: sha("8"), log: "", head: sha("6") }], 2);
    stubGitHub({
      ...good,
      [`POST ${API}/graphql`]: [
        { json: { data: null, errors: [{ message: "boom" }] } },
        ...(good[`POST ${API}/graphql`]?.slice(0, 1) ?? []),
      ],
    });
    const github = backend();
    await expect(github.tip(parseBranchName("add-tables"))).rejects.toThrow("GraphQL: boom");
    expect(await github.tip(parseBranchName("add-tables"))).toBe(sha("6"));
  });
});

describe("comparisons", () => {
  test("mergeBase reads the comparison's merge base", async () => {
    stubGitHub({
      [`GET ${REPOS}/compare/${sha("1")}...${sha("2")}?per_page=1`]: {
        json: { status: "diverged", merge_base_commit: { sha: sha("7") } },
      },
    });
    expect(await backend().mergeBase(sha("1"), sha("2"))).toBe(sha("7"));
  });

  test.each([
    ["ahead", true],
    ["identical", true],
    ["behind", false],
    ["diverged", false],
  ] as const)("isAncestor maps status %s to %s", async (status, expected) => {
    stubGitHub({
      [`GET ${REPOS}/compare/${sha("1")}...${sha("2")}?per_page=1`]: {
        json: { status, merge_base_commit: { sha: sha("1") } },
      },
    });
    expect(await backend().isAncestor(sha("1"), sha("2"))).toBe(expected);
  });

  test("unrelated histories compare as 404: no ancestry, and mergeBase is a UserError", async () => {
    const calls = stubGitHub({
      [`GET ${REPOS}/compare/${sha("1")}...${sha("2")}?per_page=1`]: {
        status: 404,
        json: { message: "Not Found" },
      },
    });
    const github = backend();
    expect(await github.isAncestor(sha("1"), sha("2"))).toBe(false);
    await expect(github.mergeBase(sha("1"), sha("2"))).rejects.toThrow(UserError);
    expect(calls).toHaveLength(1);
  });

  test("one comparison serves mergeBase and isAncestor alike", async () => {
    const calls = stubGitHub({
      [`GET ${REPOS}/compare/${sha("1")}...${sha("2")}?per_page=1`]: {
        json: { status: "ahead", merge_base_commit: { sha: sha("1") } },
      },
    });
    const github = backend();
    expect(await github.mergeBase(sha("1"), sha("2"))).toBe(sha("1"));
    expect(await github.isAncestor(sha("1"), sha("2"))).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe("commit facts", () => {
  test("mergedTip and mergedOnto read a merge's parents from one cached commit", async () => {
    const calls = stubGitHub({
      [`POST ${API}/graphql`]: batched("c", [commitNode(sha("3"), [sha("4"), sha("5")])]),
    });
    const github = backend();
    expect(await github.mergedTip(sha("3"))).toBe(sha("5"));
    expect(await github.mergedOnto(sha("3"))).toBe(sha("4"));
    expect(calls).toHaveLength(1);
  });

  test("mergedTip of a single-parent commit is a UserError", async () => {
    stubGitHub({
      [`POST ${API}/graphql`]: batched("c", [commitNode(sha("3"), [sha("4")])]),
    });
    await expect(backend().mergedTip(sha("3"))).rejects.toThrow(UserError);
  });

  test("hasRevision is whether the commit exists, asked in one batch", async () => {
    const calls = stubGitHub({
      [`POST ${API}/graphql`]: batched("c", [commitNode(sha("3"), []), null]),
    });
    const github = backend();
    const [held, gone] = await Promise.all([github.hasRevision(sha("3")), github.hasRevision(sha("4"))]);
    expect(held).toBe(true);
    expect(gone).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("a commit with more parents than a batch carries falls back to the raw read", async () => {
    const parents = Array.from({ length: 16 }, (_, i) => parseCommitHash(String(i % 10).repeat(40)));
    stubGitHub({
      [`POST ${API}/graphql`]: batched("c", [
        {
          ...commitNode(sha("3"), parents.slice(0, 15)),
          parents: { totalCount: 16, nodes: parents.slice(0, 15).map((oid) => ({ oid })) },
        },
      ]),
      [`GET ${REPOS}/git/commits/${sha("3")}`]: { json: commitJson(sha("3"), parents) },
    });
    expect(await backend().mergedTip(sha("3"))).toBe(parents[1]);
  });
});

describe("chainMerges", () => {
  const base = sha("a");

  test("surveys the first-parent chain oldest first: land merges, plain merges, squash lands", async () => {
    const c1 = sha("b");
    const landMerge = sha("c");
    const plainMerge = sha("d");
    const squashLand = sha("e");
    stubGitHub({
      [`GET ${REPOS}/compare/${base}...${squashLand}?per_page=100&page=1`]: {
        json: {
          total_commits: 5,
          commits: [
            listed(c1, [base], "plain work"),
            listed(sha("2"), [c1], "side work"),
            listed(landMerge, [c1, sha("1")], landMessage(parseBranchName("child-a"))),
            listed(plainMerge, [landMerge, sha("2")], "join sides"),
            listed(squashLand, [plainMerge], landMessage(parseBranchName("child-b"))),
          ],
        },
      },
    });
    expect(await backend().chainMerges(base, squashLand, 100)).toEqual({
      merges: [
        { commit: landMerge, onto: c1, merged: sha("1"), landed: "child-a" },
        { commit: plainMerge, onto: landMerge, merged: sha("2"), landed: undefined },
        { commit: squashLand, onto: plainMerge, merged: undefined, landed: "child-b" },
      ],
      root: base,
      more: false,
    });
  });

  test("the scan bounds the survey and reports the chain continuing", async () => {
    const c1 = sha("b");
    const c2 = sha("c");
    const c3 = sha("d");
    stubGitHub({
      [`GET ${REPOS}/compare/${base}...${c3}?per_page=100&page=1`]: {
        json: { total_commits: 3, commits: [listed(c1, [base]), listed(c2, [c1]), listed(c3, [c2])] },
      },
    });
    expect(await backend().chainMerges(base, c3, 2)).toEqual({ merges: [], root: c1, more: true });
  });

  test("stops where the first-parent chain leaves base..tip, as when the parent was merged in", async () => {
    // tip merges base in rather than descending from it: base is on tip's
    // second-parent line, and the first-parent chain runs past it to older
    // history outside the listing.
    const c1 = sha("b");
    const tip = sha("c");
    stubGitHub({
      [`GET ${REPOS}/compare/${base}...${tip}?per_page=100&page=1`]: {
        json: {
          total_commits: 2,
          commits: [listed(c1, [sha("9")], "older work"), listed(tip, [c1, base], landMessage(parseBranchName("up")))],
        },
      },
    });
    expect(await backend().chainMerges(base, tip, 100)).toEqual({
      merges: [{ commit: tip, onto: c1, merged: base, landed: "up" }],
      root: sha("9"),
      more: false,
    });
  });

  test("an identical compare surveys nothing", async () => {
    stubGitHub({
      [`GET ${REPOS}/compare/${base}...${base}?per_page=100&page=1`]: {
        json: { total_commits: 0, commits: [] },
      },
    });
    expect(await backend().chainMerges(base, base, 100)).toEqual({ merges: [], root: undefined, more: false });
  });

  test("pages a long compare and caches the answer", async () => {
    // 150 commits: chain[0] is the land merge, everything above is plain work.
    const chain = Array.from({ length: 150 }, (_, i) => parseCommitHash("0".repeat(37) + String(i).padStart(3, "0")));
    const commits = chain.map((commit, i) =>
      listed(
        commit,
        [i === 0 ? base : (chain[i - 1] as string), ...(i === 0 ? [sha("9")] : [])],
        i === 0 ? landMessage(parseBranchName("child-d")) : "work",
      ),
    );
    const tip = chain[149] as string;
    const calls = stubGitHub({
      [`GET ${REPOS}/compare/${base}...${tip}?per_page=100&page=1`]: {
        json: { total_commits: 150, commits: commits.slice(0, 100) },
      },
      [`GET ${REPOS}/compare/${base}...${tip}?per_page=100&page=2`]: {
        json: { total_commits: 150, commits: commits.slice(100) },
      },
    });
    const github = backend();
    const survey = {
      merges: [{ commit: chain[0], onto: base, merged: sha("9"), landed: "child-d" }],
      root: base,
      more: false,
    };
    expect(await github.chainMerges(base, parseCommitHash(tip), 10000)).toEqual(survey);
    expect(await github.chainMerges(base, parseCommitHash(tip), 10000)).toEqual(survey);
    expect(calls.map(({ url }) => url.slice(url.indexOf("&page=") + 1))).toEqual(["page=1", "page=2"]);
  });

  test("the page budget scales with the scan: a many-thousand-commit chain surveys completely", async () => {
    const chain = Array.from({ length: 5100 }, (_, i) => parseCommitHash("0".repeat(36) + String(i).padStart(4, "0")));
    const commits = chain.map((commit, i) => listed(commit, [i === 0 ? base : (chain[i - 1] as string)]));
    const tip = chain[5099] as string;
    const routes: Record<string, Route> = {};
    for (let page = 1; page <= 51; page++) {
      routes[`GET ${REPOS}/compare/${base}...${tip}?per_page=100&page=${page}`] = {
        json: { total_commits: 5100, commits: commits.slice((page - 1) * 100, page * 100) },
      };
    }
    const calls = stubGitHub(routes);
    expect(await backend().chainMerges(base, parseCommitHash(tip), 10_000)).toEqual({
      merges: [],
      root: base,
      more: false,
    });
    expect(calls).toHaveLength(51);
  });

  test("surveys a trunk with no base through the commits listing", async () => {
    const rootCommit = sha("1");
    const c1 = sha("2");
    const landMerge = sha("3");
    const tip = sha("4");
    stubGitHub({
      [`GET ${REPOS}/commits?sha=${tip}&per_page=100&page=1`]: {
        json: [
          listed(tip, [landMerge], "after the land"),
          listed(landMerge, [c1, sha("5")], landMessage(parseBranchName("child-e"))),
          listed(c1, [rootCommit], "early work"),
          listed(rootCommit, [], "first commit"),
        ],
      },
    });
    expect(await backend().chainMerges(undefined, tip, 100)).toEqual({
      merges: [{ commit: landMerge, onto: c1, merged: sha("5"), landed: "child-e" }],
      root: undefined,
      more: false,
    });
  });
});

describe("files", () => {
  test("readFile answers from one batch, absences and directories included", async () => {
    const batch = batched("b", [
      blobNode("export const x = 1;\n"),
      // No file at the path: the field nulls out under a path-scoped error.
      { file: null },
      // A directory answers empty under the Blob fragment.
      { file: { object: {} } },
    ]);
    const calls = stubGitHub({
      [`POST ${API}/graphql`]: {
        json: {
          ...(batch.json as object),
          errors: [{ message: "Could not resolve file for path 'missing.ts'.", path: ["repository", "b1", "file"] }],
        },
      },
    });
    const github = backend();
    const [text, missing, directory] = await Promise.all([
      github.readFile(sha("1"), parseFilePath("src/app.ts")),
      github.readFile(sha("1"), parseFilePath("missing.ts")),
      github.readFile(sha("1"), parseFilePath("src")),
    ]);
    expect(text).toBe("export const x = 1;\n");
    expect(missing).toBeUndefined();
    expect(directory).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  test("a binary or oversized blob rereads raw over REST", async () => {
    stubGitHub({
      [`POST ${API}/graphql`]: batched("b", [{ file: { object: { isTruncated: true, text: null } } }]),
      [`GET ${REPOS}/contents/big.bin?ref=${sha("1")}`]: { json: "raw bytes" },
    });
    expect(await backend().readFile(sha("1"), parseFilePath("big.bin"))).toBe("raw bytes");
  });

  test("hash-keyed queries cache: repeat asks cost no further requests", async () => {
    const calls = stubGitHub({
      [`POST ${API}/graphql`]: batched("b", [blobNode("one\n")]),
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
      [`POST ${API}/graphql`]: [
        { status: 401, json: { message: "Bad credentials" } },
        batched("b", [blobNode("one\n")]),
      ],
    });
    const github = backend();
    await expect(github.readFile(sha("1"), parseFilePath("a.ts"))).rejects.toMatchObject({ status: 401 });
    expect(await github.readFile(sha("1"), parseFilePath("a.ts"))).toBe("one\n");
    expect(calls).toHaveLength(2);
  });

  test("changedFiles diffs the trees: edits, chmods, moves, copies, and no submodules", async () => {
    stubGitHub({
      [`POST ${API}/graphql`]: batched("c", [
        commitNode(sha("1"), [], "base", "1a".repeat(20)),
        commitNode(sha("2"), [sha("1")], "tip", "2b".repeat(20)),
      ]),
      [`GET ${REPOS}/git/trees/${"1a".repeat(20)}?recursive=1`]: {
        json: {
          truncated: false,
          tree: [
            { path: "docs", mode: "040000", type: "tree", sha: sha("3") },
            { path: "docs/old-name.md", mode: "100644", type: "blob", sha: sha("4") },
            { path: "gone.txt", mode: "100644", type: "blob", sha: sha("5") },
            { path: "run.sh", mode: "100644", type: "blob", sha: sha("6") },
            { path: "same.txt", mode: "100644", type: "blob", sha: sha("7") },
            { path: "src/util.ts", mode: "100644", type: "blob", sha: sha("8") },
            { path: "vendored", mode: "160000", type: "commit", sha: sha("9") },
            { path: "zebra.ts", mode: "100644", type: "blob", sha: sha("a") },
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
            // The addition: a blob from nowhere.
            { path: "fresh.txt", mode: "100644", type: "blob", sha: sha("b") },
            // The chmod: same blob, executable now.
            { path: "run.sh", mode: "100755", type: "blob", sha: sha("6") },
            { path: "same.txt", mode: "100644", type: "blob", sha: sha("7") },
            // The edit, whose old blob src/util2.ts copies.
            { path: "src/util.ts", mode: "100644", type: "blob", sha: sha("c") },
            { path: "src/util2.ts", mode: "100644", type: "blob", sha: sha("8") },
            // The submodule bump: never a file, never listed.
            { path: "vendored", mode: "160000", type: "commit", sha: sha("d") },
            { path: "zebra.ts", mode: "100644", type: "blob", sha: sha("e") },
          ],
        },
      },
    });
    expect(await backend().changedFiles(sha("1"), sha("2"))).toEqual([
      { path: "docs/new-name.md", source: { path: "docs/old-name.md", copied: false } },
      { path: "fresh.txt", source: undefined },
      { path: "gone.txt", source: undefined },
      { path: "run.sh", source: undefined },
      { path: "src/util.ts", source: undefined },
      { path: "src/util2.ts", source: { path: "src/util.ts", copied: true } },
      { path: "zebra.ts", source: undefined },
    ]);
  });

  test("changedFiles refuses a truncated tree listing rather than misreporting", async () => {
    stubGitHub({
      [`POST ${API}/graphql`]: batched("c", [
        commitNode(sha("1"), [], "base", "1a".repeat(20)),
        commitNode(sha("2"), [], "tip", "2b".repeat(20)),
      ]),
      [`GET ${REPOS}/git/trees/${"1a".repeat(20)}?recursive=1`]: { json: { truncated: true, tree: [] } },
      [`GET ${REPOS}/git/trees/${"2b".repeat(20)}?recursive=1`]: { json: { truncated: false, tree: [] } },
    });
    await expect(backend().changedFiles(sha("1"), sha("2"))).rejects.toThrow("tree too large");
  });
});

describe("branches", () => {
  test("create posts the new ref", async () => {
    const calls = stubGitHub({
      [`POST ${REPOS}/git/refs`]: { status: 201, json: {} },
    });
    await backend().create(parseBranchName("topic"), sha("4"));
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ ref: "refs/heads/topic", sha: sha("4") });
  });

  test("advance fast-forwards with an unforced update", async () => {
    const calls = stubGitHub({
      [`GET ${REPOS}/git/ref/heads%2Ftopic`]: { json: { object: { type: "commit", sha: sha("1") } } },
      [`GET ${REPOS}/compare/${sha("1")}...${sha("2")}?per_page=1`]: {
        json: { status: "ahead", merge_base_commit: { sha: sha("1") } },
      },
      [`PATCH ${REPOS}/git/refs/heads%2Ftopic`]: { json: {} },
    });
    await backend().advance(parseBranchName("topic"), sha("2"));
    const patch = calls.find(({ method }) => method === "PATCH");
    expect(JSON.parse(patch?.body ?? "{}")).toEqual({ sha: sha("2"), force: false });
  });

  test("advance is a no-op when the branch is already there", async () => {
    const calls = stubGitHub({
      [`GET ${REPOS}/git/ref/heads%2Ftopic`]: { json: { object: { type: "commit", sha: sha("2") } } },
    });
    await backend().advance(parseBranchName("topic"), sha("2"));
    expect(calls).toHaveLength(1);
  });

  test("advance refuses a target that does not descend from the tip", async () => {
    stubGitHub({
      [`GET ${REPOS}/git/ref/heads%2Ftopic`]: { json: { object: { type: "commit", sha: sha("1") } } },
      [`GET ${REPOS}/compare/${sha("1")}...${sha("3")}?per_page=1`]: {
        json: { status: "diverged", merge_base_commit: { sha: sha("9") } },
      },
    });
    await expect(backend().advance(parseBranchName("topic"), sha("3"))).rejects.toThrow("does not descend");
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

  test("listChanges is the swept changes, sorted", async () => {
    stubGitHub(
      sweepRoutes([
        { change: "zeta", logTip: sha("1"), log: "", head: sha("5") },
        { change: "alpha", logTip: sha("2"), log: "", head: sha("6") },
      ]),
    );
    expect(await backend().listChanges()).toEqual(["alpha", "zeta"]);
  });

  test("wipeOriginLogs deletes every log ref", async () => {
    const calls = stubGitHub({
      ...sweepRoutes([
        { change: "zeta", logTip: sha("1"), log: "", head: null },
        { change: "alpha", logTip: sha("2"), log: "", head: null },
      ]),
      // GitHub answers 204, but a body-less status cannot carry the stub's
      // json; 200 exercises the same success path.
      [`DELETE ${REPOS}/git/refs/cabaret%2Flog%2Falpha`]: { json: {} },
      [`DELETE ${REPOS}/git/refs/cabaret%2Flog%2Fzeta`]: { json: {} },
    });
    expect(await backend().wipeOriginLogs()).toEqual(["alpha", "zeta"]);
    expect(calls.map(({ method, url }) => `${method} ${url}`).slice(2)).toEqual([
      `DELETE ${REPOS}/git/refs/cabaret%2Flog%2Falpha`,
      `DELETE ${REPOS}/git/refs/cabaret%2Flog%2Fzeta`,
    ]);
  });

  test("deleteLog tolerates a log already deleted elsewhere", async () => {
    stubGitHub({
      [`DELETE ${REPOS}/git/refs/cabaret%2Flog%2Fgone`]: { status: 422, json: { message: "Reference does not exist" } },
    });
    await expect(backend().deleteLog(parseBranchName("gone"))).resolves.toBeUndefined();
  });

  test("readLog is empty for a change outside the sweep", async () => {
    stubGitHub(sweepRoutes([]));
    expect(await backend().readLog(parseBranchName("unknown"))).toEqual([]);
  });

  test("readLog parses the swept log text without further requests", async () => {
    const calls = stubGitHub(
      sweepRoutes([{ change: "add-tables", logTip: sha("8"), log: formatLogEntry(entry), head: sha("6") }]),
    );
    const github = backend();
    expect(await github.readLog(parseBranchName("add-tables"))).toEqual([entry]);
    expect(await github.readLog(parseBranchName("add-tables"))).toEqual([entry]);
    expect(calls).toHaveLength(2);
  });

  test("a truncated log blob rereads raw rather than serving a partial log", async () => {
    const swept = sweepRoutes([{ change: "add-tables", logTip: sha("8"), log: "", head: sha("6"), truncated: true }]);
    stubGitHub({
      ...swept,
      [`POST ${API}/graphql`]: [
        ...(swept[`POST ${API}/graphql`] ?? []),
        // The batched reread sees the same truncation and goes raw.
        batched("b", [{ file: { object: { isTruncated: true, text: null } } }]),
      ],
      [`GET ${REPOS}/contents/log?ref=${sha("8")}`]: { json: formatLogEntry(entry) + formatLogEntry(other) },
    });
    expect(await backend().readLog(parseBranchName("add-tables"))).toEqual([entry, other]);
  });

  test("appendLog creates the log when none exists", async () => {
    const calls = stubGitHub({
      [`GET ${REPOS}/git/ref/cabaret%2Flog%2Ffresh`]: { status: 404, json: { message: "Not Found" } },
      [`POST ${REPOS}/git/blobs`]: { status: 201, json: { sha: "b".repeat(40) } },
      [`POST ${REPOS}/git/trees`]: { status: 201, json: { sha: "d".repeat(40) } },
      [`POST ${REPOS}/git/commits`]: { status: 201, json: { sha: sha("9") } },
      [`POST ${REPOS}/git/refs`]: { status: 201, json: {} },
    });
    await backend().appendLog(parseBranchName("fresh"), [entry]);
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
      [`POST ${API}/graphql`]: [
        batched("b", [blobNode(formatLogEntry(entry))]),
        // The concurrent append that won the first swap added `other`.
        batched("b", [blobNode(formatLogEntry(entry) + formatLogEntry(other))]),
      ],
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
    await backend().appendLog(parseBranchName("busy"), [appended]);
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
      [`POST ${API}/graphql`]: [
        batched("b", [blobNode(formatLogEntry(entry))]),
        batched("b", [blobNode(formatLogEntry(entry) + formatLogEntry(other))]),
      ],
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
    const change = parseBranchName("busy");
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
      [`POST ${API}/graphql`]: batched("b", [blobNode(formatLogEntry(entry))]),
      [`POST ${REPOS}/git/blobs`]: { status: 201, json: { sha: "b".repeat(40) } },
      [`POST ${REPOS}/git/trees`]: { status: 201, json: { sha: "d".repeat(40) } },
      [`POST ${REPOS}/git/commits`]: { status: 201, json: { sha: sha("3") } },
      [`PATCH ${REPOS}/git/refs/cabaret%2Flog%2Fbusy`]: { json: {} },
    });
    const github = backend();
    const change = parseBranchName("busy");
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
    await backend().appendLog(parseBranchName("idle"), []);
    expect(calls).toEqual([]);
  });

  test("an append folds into the held epoch: rereads see it without a fetch", async () => {
    const swept = sweepRoutes([{ change: "busy", logTip: sha("1"), log: formatLogEntry(entry), head: sha("5") }]);
    stubGitHub({
      ...swept,
      [`POST ${API}/graphql`]: [
        ...(swept[`POST ${API}/graphql`] ?? []),
        batched("b", [blobNode(formatLogEntry(entry))]),
      ],
      [`GET ${REPOS}/git/ref/cabaret%2Flog%2Fbusy`]: { json: { object: { type: "commit", sha: sha("1") } } },
      [`POST ${REPOS}/git/blobs`]: { status: 201, json: { sha: "b".repeat(40) } },
      [`POST ${REPOS}/git/trees`]: { status: 201, json: { sha: "d".repeat(40) } },
      [`POST ${REPOS}/git/commits`]: { status: 201, json: { sha: sha("9") } },
      [`PATCH ${REPOS}/git/refs/cabaret%2Flog%2Fbusy`]: { json: {} },
    });
    const github = backend();
    const change = parseBranchName("busy");
    expect(await github.readLog(change)).toEqual([entry]);
    await github.appendLog(change, [other]);
    expect(await github.readLog(change)).toEqual([entry, other]);
  });
});

describe("durable store", () => {
  test("immutable facts answer from the store across backends, undefined included", async () => {
    const held = new Map<string, string>();
    const store = {
      get: (key: string) => held.get(key),
      set: (key: string, value: string) => void held.set(key, value),
    };
    const stored = (): GitHubBackend =>
      new GitHubBackend(githubClient("token-123", { throttled: false }), { owner: "test-org", repo: "widgets" }, store);
    const calls = stubGitHub({
      [`POST ${API}/graphql`]: [
        batched("c", [commitNode(sha("3"), [sha("4"), sha("5")])]),
        batched("b", [{ file: null }]),
      ],
    });
    const first = stored();
    expect(await first.mergedTip(sha("3"))).toBe(sha("5"));
    expect(await first.readFile(sha("3"), parseFilePath("gone.ts"))).toBeUndefined();
    const second = stored();
    expect(await second.mergedTip(sha("3"))).toBe(sha("5"));
    expect(await second.readFile(sha("3"), parseFilePath("gone.ts"))).toBeUndefined();
    expect(calls).toHaveLength(2);
  });
});

describe("config", () => {
  test("settings live in memory for the session, with git's last-value and multi-value reads", async () => {
    const calls = stubGitHub({});
    const github = backend();
    expect(await github.config("cabaret.reviewer")).toBeUndefined();
    await github.configSet("cabaret.reviewer", "carol@example.com", "local");
    expect(await github.config("cabaret.reviewer")).toBe("carol@example.com");
    await github.configAdd("cabaret.alias", "alice@example.com", "global");
    await github.configAdd("cabaret.alias", "github:alice", "global");
    expect(await github.configAll("cabaret.alias")).toEqual(["alice@example.com", "github:alice"]);
    expect(await github.config("cabaret.alias")).toBe("github:alice");
    expect(await github.configUnset("cabaret.alias", "global", "alice@example.com")).toBe(true);
    expect(await github.configAll("cabaret.alias")).toEqual(["github:alice"]);
    expect(await github.configUnset("cabaret.missing", "local")).toBe(false);
    expect(await github.configUnset("cabaret.reviewer", "local")).toBe(true);
    expect(await github.config("cabaret.reviewer")).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe("resolveFile", () => {
  test("normalizes a repository-relative path", () => {
    stubGitHub({});
    const github = backend();
    expect(github.resolveFile("src/app.ts")).toBe("src/app.ts");
    expect(github.resolveFile("./src//app.ts")).toBe("src/app.ts");
    expect(github.resolveFile("src/../docs/spec.md")).toBe("docs/spec.md");
  });

  test("rejects a path that escapes the repository", () => {
    stubGitHub({});
    expect(() => backend().resolveFile("../secrets")).toThrow(UserError);
    expect(() => backend().resolveFile("")).toThrow(UserError);
  });
});

describe("operations needing a local repository", () => {
  test.each([
    ["currentChange", () => backend().currentChange()],
    ["checkout", () => backend().checkout()],
    ["commit", () => backend().commit()],
    ["rename", () => backend().rename()],
    ["mergeOnto", () => backend().mergeOnto()],
    ["mergeConflicts", () => backend().mergeConflicts()],
    ["merge", () => backend().merge()],
    ["squash", () => backend().squash()],
    ["addWorkspace", () => backend().addWorkspace()],
    ["removeWorkspace", () => backend().removeWorkspace()],
  ])("%s is a UserError", async (_name, call) => {
    stubGitHub({});
    await expect(call()).rejects.toThrow(UserError);
  });

  test("the sync operations are no-ops with nothing to reconcile", async () => {
    const calls = stubGitHub(sweepRoutes([{ change: "only", logTip: sha("1"), log: "", head: sha("2") }]));
    const github = backend();
    await github.syncLog();
    await github.push();
    await github.fetch();
    expect(await github.advanceBranches()).toEqual([]);
    expect(await github.wipeReviewState()).toEqual([]);
    expect(await github.workspaces()).toEqual([]);
    expect(github.setupRecommendations()).toEqual([]);
    expect(calls).toEqual([]);
    expect(await github.syncLogs()).toEqual(["only"]);
  });
});

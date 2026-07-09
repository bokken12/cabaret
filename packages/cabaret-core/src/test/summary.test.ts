import { expect, test } from "vitest";
import {
  type Backend,
  type CommitHash,
  changeForest,
  type FilePath,
  type FileView,
  forgeChangeId,
  type LogAction,
  type LogEntry,
  parseCommitHash,
  parseFilePath,
  parseForgeLocator,
  parseRefName,
  type RefName,
  reviewRounds,
  summarizeChange,
  timestampMs,
  userName,
} from "../index.js";

function refs(parents: Record<string, string>): ReadonlyMap<RefName, RefName> {
  return new Map(Object.entries(parents).map(([change, parent]) => [parseRefName(change), parseRefName(parent)]));
}

test("changeForest nests children under parents, roots and children sorted", () => {
  const parents = refs({
    widgets: "main",
    "widgets-ui": "widgets",
    "widgets-api": "widgets",
    docs: "main",
    orphan: "gone-branch",
  });
  expect(changeForest(parents)).toEqual([
    { change: "docs", children: [] },
    { change: "orphan", children: [] },
    {
      change: "widgets",
      children: [
        { change: "widgets-api", children: [] },
        { change: "widgets-ui", children: [] },
      ],
    },
  ]);
  expect(changeForest(new Map())).toEqual([]);
});

test("changeForest rejects a parent cycle", () => {
  const parents = refs({ a: "b", b: "a", c: "main" });
  expect(() => changeForest(parents)).toThrow("parent links form a cycle among: a, b");
});

/** The fake commit `digit.repeat(40)`, hex digits only. */
function fake(digit: string): CommitHash {
  return parseCommitHash(digit.repeat(40));
}

/**
 * A backend over fake one-digit commits. `history` maps each commit to its
 * first parent; `branches` maps branch names to commits; `changed` maps
 * `<base><tip>` digit pairs to the files differing between them, and a pair
 * the test did not anticipate is an error. Only the members `summarizeChange`
 * touches exist.
 */
function repoBackend(opts: {
  history: Record<string, string>;
  branches: Record<string, string>;
  merges?: readonly { commit: string; onto: string }[];
  changed?: Record<string, readonly string[]>;
  /** Second parents of merge commits, for `<merge>^2` resolution. */
  tips?: Record<string, string>;
}): Backend {
  const ancestry = (tip: CommitHash): CommitHash[] => {
    const chain = [tip];
    for (let up = opts.history[tip[0] as string]; up !== undefined; up = opts.history[up]) {
      chain.push(fake(up));
    }
    return chain;
  };
  const tipOf = (branch: string): CommitHash => {
    const digit = opts.branches[branch.replace(/^refs\/heads\//, "")];
    if (digit === undefined) {
      throw new Error(`no branch: ${branch}`);
    }
    return fake(digit);
  };
  const stub: Pick<
    Backend,
    "resolveCommit" | "branchTip" | "mergeBase" | "isAncestor" | "landMerges" | "changedFiles"
  > = {
    async resolveCommit(revision) {
      const merge = /^(\w)\1{39}\^2$/.exec(revision);
      if (merge === null) {
        return tipOf(revision);
      }
      const digit = opts.tips?.[merge[1] as string];
      if (digit === undefined) {
        throw new Error(`unexpected resolveCommit query: ${revision}`);
      }
      return fake(digit);
    },
    async branchTip(branch) {
      const digit = opts.branches[branch as string];
      return digit === undefined ? undefined : fake(digit);
    },
    async mergeBase(a, b) {
      const shared = new Set(ancestry(tipOf(b)));
      const found = ancestry(tipOf(a)).find((commit) => shared.has(commit));
      if (found === undefined) {
        throw new Error(`no merge base of ${a} and ${b}`);
      }
      return found;
    },
    async isAncestor(ancestor, descendant) {
      return ancestry(descendant).includes(ancestor);
    },
    async landMerges(base, tip) {
      const path = ancestry(tip);
      const cut = path.indexOf(base);
      const between = new Set(cut === -1 ? path : path.slice(0, cut));
      return (opts.merges ?? [])
        .map(({ commit, onto }) => ({ commit: fake(commit), onto: fake(onto) }))
        .filter(({ commit }) => between.has(commit))
        .sort((a, b) => path.indexOf(b.commit) - path.indexOf(a.commit));
    },
    async changedFiles(base, tip) {
      if (base === tip) {
        return [];
      }
      const files = opts.changed?.[`${base[0]}${tip[0]}`];
      if (files === undefined) {
        throw new Error(`unexpected changedFiles query: ${base[0]}..${tip[0]}`);
      }
      return files.map(parseFilePath);
    },
  };
  return stub as Backend;
}

const alice = userName("alice@example.com");
const bob = userName("bob@example.com");

function entry(action: LogAction): LogEntry {
  return { timestamp: timestampMs(1748000000000), user: alice, action };
}

/** The entries `create` seeds a log with: parented on `parent`, based at `base`, owned by alice. */
function created(parent: string, base: string): LogEntry[] {
  return [
    entry({ kind: "set-parent", parent: parseRefName(parent) }),
    entry({ kind: "set-base", base: fake(base) }),
    entry({ kind: "set-owner", owner: alice }),
  ];
}

function review(file: string, base: string, tip: string): LogAction {
  return { kind: "review", file: parseFilePath(file), base: fake(base), tip: fake(tip) };
}

const feature = parseRefName("feature");

test("a change with no commits of its own must add code", async () => {
  const backend = repoBackend({ history: { "1": "0" }, branches: { main: "1", feature: "1" } });
  expect(await summarizeChange(backend, feature, created("main", "1"), alice)).toEqual({
    change: "feature",
    parent: "main",
    owner: alice,
    forgeChange: undefined,
    landed: undefined,
    base: fake("1"),
    tip: fake("1"),
    reviewLeft: [],
    nextStep: "add code",
  });
});

test("files outside the user's brain are left to review", async () => {
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "3": "2" },
    branches: { main: "1", feature: "3" },
    changed: { "13": ["b.ts", "a.ts"] },
  });
  const entries = [...created("main", "1"), entry(review("a.ts", "1", "3"))];
  expect(await summarizeChange(backend, feature, entries, alice)).toEqual({
    change: "feature",
    parent: "main",
    owner: alice,
    forgeChange: undefined,
    landed: undefined,
    base: fake("1"),
    tip: fake("3"),
    reviewLeft: ["b.ts"],
    nextStep: "review",
  });
  // bob has reviewed nothing, so both files are left, sorted by name.
  expect(await summarizeChange(backend, feature, entries, bob)).toEqual({
    change: "feature",
    parent: "main",
    owner: alice,
    forgeChange: undefined,
    landed: undefined,
    base: fake("1"),
    tip: fake("3"),
    reviewLeft: ["a.ts", "b.ts"],
    nextStep: "review",
  });
});

test("a reviewed change not based on its parent's tip must rebase", async () => {
  // main advanced to 2 while feature (3-4) still forks from 1.
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "3": "1", "4": "3" },
    branches: { main: "2", feature: "4" },
    changed: { "14": ["a.ts"] },
  });
  const entries = [...created("main", "1"), entry(review("a.ts", "1", "4"))];
  expect(await summarizeChange(backend, feature, entries, alice)).toEqual({
    change: "feature",
    parent: "main",
    owner: alice,
    forgeChange: undefined,
    landed: undefined,
    base: fake("1"),
    tip: fake("4"),
    reviewLeft: [],
    nextStep: "rebase",
  });
});

test("a reviewed change based on its parent's tip may land", async () => {
  const backend = repoBackend({
    history: { "1": "0", "3": "1", "4": "3" },
    branches: { main: "1", feature: "4" },
    changed: { "14": ["a.ts"] },
  });
  const entries = [...created("main", "1"), entry(review("a.ts", "1", "4"))];
  expect(await summarizeChange(backend, feature, entries, alice)).toEqual({
    change: "feature",
    parent: "main",
    owner: alice,
    forgeChange: undefined,
    landed: undefined,
    base: fake("1"),
    tip: fake("4"),
    reviewLeft: [],
    nextStep: "land",
  });
});

test("a landed change reports its merge, and a moved-base review counts as left", async () => {
  // The branch is gone, as after post-land cleanup: the tip comes from the
  // land merge's second parent.
  const backend = repoBackend({
    history: { "1": "0", "3": "1", "4": "3" },
    branches: { main: "5" },
    changed: { "14": ["b.ts", "a.ts"] },
    tips: { "5": "4" },
  });
  const entries = [
    ...created("main", "1"),
    entry({ kind: "set-forge", forge: parseForgeLocator("github.com/test-org/widgets"), id: forgeChangeId(7) }),
    // Reviewed against base 0, but the change's base is 1: stale outright.
    entry(review("a.ts", "0", "4")),
    entry({ kind: "land", merge: fake("5") }),
  ];
  expect(await summarizeChange(backend, feature, entries, alice)).toEqual({
    change: "feature",
    parent: "main",
    owner: alice,
    forgeChange: { forge: "github.com/test-org/widgets", id: 7 },
    landed: fake("5"),
    base: fake("1"),
    tip: fake("4"),
    reviewLeft: ["a.ts", "b.ts"],
    nextStep: "landed",
  });
});

/** A `{file: view}` record as the round's file map, for terse expectations. */
function files(views: Record<string, FileView>): ReadonlyMap<FilePath, FileView> {
  return new Map(Object.entries(views).map(([file, view]) => [parseFilePath(file), view]));
}

test("reviewRounds splits review at land merges, oldest first", async () => {
  // 2 is a land merge (onto 1), so review spans 0-1 and 2-3.
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "3": "2" },
    branches: { main: "0", feature: "3" },
    merges: [{ commit: "2", onto: "1" }],
    changed: { "01": ["a.ts", "c.ts"], "23": ["b.ts", "c.ts"] },
  });
  expect(await reviewRounds(backend, created("main", "0"), bob, fake("0"), fake("3"))).toEqual([
    {
      end: fake("1"),
      files: files({ "a.ts": { kind: "span", start: fake("0") }, "c.ts": { kind: "span", start: fake("0") } }),
    },
    {
      end: fake("3"),
      files: files({ "b.ts": { kind: "span", start: fake("2") }, "c.ts": { kind: "span", start: fake("2") } }),
    },
  ]);
});

test("reviewRounds resumes mid-span from a reviewed tip", async () => {
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "3": "2" },
    branches: { main: "0", feature: "3" },
    changed: { "03": ["a.ts", "b.ts"], "23": ["a.ts"] },
  });
  const entries = [...created("main", "0"), entry(review("a.ts", "0", "2")), entry(review("b.ts", "0", "2"))];
  // a.ts changed again after the reviewed tip 2; b.ts did not, so it is done.
  expect(await reviewRounds(backend, entries, alice, fake("0"), fake("3"))).toEqual([
    { end: fake("3"), files: files({ "a.ts": { kind: "span", start: fake("2") } }) },
  ]);
});

test("reviewRounds carries misplaced reviews into the earliest round's view", async () => {
  // 2 is a land merge (onto 1). alice's review of a.ts predates the current
  // base, and her review of c.ts names a tip 9 that a rewrite removed from
  // history; both changed in both spans.
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "3": "2" },
    branches: { main: "0", feature: "3" },
    merges: [{ commit: "2", onto: "1" }],
    changed: { "01": ["a.ts", "c.ts"], "23": ["a.ts", "c.ts"], "93": ["c.ts"] },
  });
  const entries = [...created("main", "0"), entry(review("a.ts", "9", "2")), entry(review("c.ts", "0", "9"))];
  expect(await reviewRounds(backend, entries, alice, fake("0"), fake("3"))).toEqual([
    {
      end: fake("1"),
      files: files({
        "a.ts": { kind: "rebased", reviewed: { base: fake("9"), tip: fake("2") } },
        "c.ts": { kind: "rewritten", from: fake("9") },
      }),
    },
    {
      end: fake("3"),
      files: files({ "a.ts": { kind: "span", start: fake("2") }, "c.ts": { kind: "span", start: fake("2") } }),
    },
  ]);
});

test("reviewRounds drops a rewritten-tip review whose file ends up unchanged", async () => {
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "3": "2" },
    branches: { main: "0", feature: "3" },
    changed: { "03": ["a.ts"], "93": [] },
  });
  const entries = [...created("main", "0"), entry(review("a.ts", "0", "9"))];
  expect(await reviewRounds(backend, entries, alice, fake("0"), fake("3"))).toEqual([]);
});

test("review left skips land merges and diffs from a rewritten reviewed tip", async () => {
  // 2 is a land merge (onto 1), so review spans 0-1 and 2-3. alice reviewed
  // a.ts through 2 (covering 0-1), and c.ts to a tip 9 that a rewrite removed
  // from history.
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "3": "2" },
    branches: { main: "0", feature: "3" },
    merges: [{ commit: "2", onto: "1" }],
    changed: { "01": ["a.ts", "c.ts"], "23": ["b.ts", "c.ts"], "93": ["c.ts"] },
  });
  const entries = [...created("main", "0"), entry(review("a.ts", "0", "2")), entry(review("c.ts", "0", "9"))];
  expect(await summarizeChange(backend, feature, entries, alice)).toEqual({
    change: "feature",
    parent: "main",
    owner: alice,
    forgeChange: undefined,
    landed: undefined,
    base: fake("0"),
    tip: fake("3"),
    reviewLeft: ["b.ts", "c.ts"],
    nextStep: "review",
  });
});

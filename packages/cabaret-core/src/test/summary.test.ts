import { expect, test } from "vitest";
import {
  type Backend,
  type ChangeSummary,
  type CommitHash,
  changeDiff,
  changeForest,
  diffBetween,
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
  type ReviewRound,
  reviewRounds,
  summarizeChange,
  timestampMs,
  type UserName,
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
  /** Origin's last-fetched branch tips, for `originTip`. */
  origin?: Record<string, string>;
  /** Change logs by name, for `readLog`; an unlisted name reads as empty. */
  logs?: Record<string, readonly LogEntry[]>;
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
    "resolveCommit" | "branchTip" | "originTip" | "mergeBase" | "isAncestor" | "landMerges" | "changedFiles" | "readLog"
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
    async originTip(branch) {
      const digit = opts.origin?.[branch as string];
      return digit === undefined ? undefined : fake(digit);
    },
    async readLog(change) {
      return opts.logs?.[change as string] ?? [];
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

/** Summarize `change` with its diff read afresh from the log, as the pages do. */
async function summarize(
  backend: Backend,
  change: RefName,
  entries: readonly LogEntry[],
  user: UserName,
): Promise<ChangeSummary> {
  return summarizeChange(backend, change, entries, user, await changeDiff(backend, change, entries));
}

/** The rounds left for `user`, the diff of `base`..`tip` read afresh. */
async function rounds(
  backend: Backend,
  entries: readonly LogEntry[],
  user: UserName,
  base: CommitHash,
  tip: CommitHash,
): Promise<readonly ReviewRound[]> {
  return reviewRounds(backend, entries, user, await diffBetween(backend, base, tip));
}

test("a change with no commits of its own must add code", async () => {
  const backend = repoBackend({ history: { "1": "0" }, branches: { main: "1", feature: "1" } });
  expect(await summarize(backend, feature, created("main", "1"), alice)).toEqual({
    change: "feature",
    parent: "main",
    owner: alice,
    reviewers: [],
    forgeChange: undefined,
    landed: undefined,
    base: fake("1"),
    tip: fake("1"),
    origin: undefined,
    deadParent: undefined,
    staleBase: undefined,
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
  expect(await summarize(backend, feature, entries, alice)).toEqual({
    change: "feature",
    parent: "main",
    owner: alice,
    reviewers: [],
    forgeChange: undefined,
    landed: undefined,
    base: fake("1"),
    tip: fake("3"),
    origin: undefined,
    deadParent: undefined,
    staleBase: undefined,
    reviewLeft: ["b.ts"],
    nextStep: "review",
  });
  // bob has reviewed nothing, so both files are left, sorted by name.
  expect(await summarize(backend, feature, entries, bob)).toEqual({
    change: "feature",
    parent: "main",
    owner: alice,
    reviewers: [],
    forgeChange: undefined,
    landed: undefined,
    base: fake("1"),
    tip: fake("3"),
    origin: undefined,
    deadParent: undefined,
    staleBase: undefined,
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
  expect(await summarize(backend, feature, entries, alice)).toEqual({
    change: "feature",
    parent: "main",
    owner: alice,
    reviewers: [],
    forgeChange: undefined,
    landed: undefined,
    base: fake("1"),
    tip: fake("4"),
    origin: undefined,
    deadParent: undefined,
    staleBase: "behind",
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
  expect(await summarize(backend, feature, entries, alice)).toEqual({
    change: "feature",
    parent: "main",
    owner: alice,
    reviewers: [],
    forgeChange: undefined,
    landed: undefined,
    base: fake("1"),
    tip: fake("4"),
    origin: undefined,
    deadParent: undefined,
    staleBase: undefined,
    reviewLeft: [],
    nextStep: "land",
  });
});

test("a landed change reports its merge, and a moved-base review counts as left", async () => {
  // The branch is gone, as after post-land cleanup: the tip comes from the
  // land merge's second parent. Origin having moved on does not matter; the
  // change is frozen, so landed outranks sync.
  const backend = repoBackend({
    history: { "1": "0", "3": "1", "4": "3" },
    branches: { main: "5" },
    changed: { "14": ["b.ts", "a.ts"] },
    tips: { "5": "4" },
    origin: { feature: "9" },
  });
  const entries = [
    ...created("main", "1"),
    entry({ kind: "set-forge", forge: parseForgeLocator("github.com/test-org/widgets"), id: forgeChangeId(7) }),
    // Reviewed against base 0, but the change's base is 1: stale outright.
    entry(review("a.ts", "0", "4")),
    entry({ kind: "land", merge: fake("5") }),
  ];
  expect(await summarize(backend, feature, entries, alice)).toEqual({
    change: "feature",
    parent: "main",
    owner: alice,
    reviewers: [],
    forgeChange: { forge: "github.com/test-org/widgets", id: 7 },
    landed: fake("5"),
    base: fake("1"),
    tip: fake("4"),
    origin: undefined,
    deadParent: undefined,
    staleBase: undefined,
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
  expect(await rounds(backend, created("main", "0"), bob, fake("0"), fake("3"))).toEqual([
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
  expect(await rounds(backend, entries, alice, fake("0"), fake("3"))).toEqual([
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
  expect(await rounds(backend, entries, alice, fake("0"), fake("3"))).toEqual([
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
  expect(await rounds(backend, entries, alice, fake("0"), fake("3"))).toEqual([]);
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
  expect(await summarize(backend, feature, entries, alice)).toEqual({
    change: "feature",
    parent: "main",
    owner: alice,
    reviewers: [],
    forgeChange: undefined,
    landed: undefined,
    base: fake("0"),
    tip: fake("3"),
    origin: undefined,
    deadParent: undefined,
    staleBase: undefined,
    reviewLeft: ["b.ts", "c.ts"],
    nextStep: "review",
  });
});

test("a change behind origin's copy must sync, before anything else", async () => {
  // Origin's widgets moved to 2 while the local branch still sits at 1.
  const backend = repoBackend({
    history: { "1": "0", "2": "1" },
    branches: { main: "1", widgets: "1" },
    origin: { widgets: "2" },
  });
  const widgets = parseRefName("widgets");
  expect(await summarize(backend, widgets, created("main", "1"), alice)).toEqual({
    change: "widgets",
    parent: "main",
    owner: alice,
    reviewers: [],
    forgeChange: undefined,
    landed: undefined,
    base: fake("1"),
    tip: fake("1"),
    origin: "behind",
    deadParent: undefined,
    staleBase: undefined,
    reviewLeft: [],
    nextStep: "sync",
  });
});

test("a change diverged from origin's copy must sync, review left or not", async () => {
  // The local branch was rewritten to 3 while origin still holds the old 2.
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "3": "1" },
    branches: { main: "1", widgets: "3" },
    origin: { widgets: "2" },
    changed: { "13": ["a.ts"] },
  });
  const widgets = parseRefName("widgets");
  expect(await summarize(backend, widgets, created("main", "1"), alice)).toEqual({
    change: "widgets",
    parent: "main",
    owner: alice,
    reviewers: [],
    forgeChange: undefined,
    landed: undefined,
    base: fake("1"),
    tip: fake("3"),
    origin: "diverged",
    deadParent: undefined,
    staleBase: undefined,
    reviewLeft: ["a.ts"],
    nextStep: "sync",
  });
});

test("a change ahead of origin's copy notes it and moves on", async () => {
  const backend = repoBackend({
    history: { "1": "0", "2": "1" },
    branches: { main: "1", widgets: "2" },
    origin: { widgets: "1" },
    changed: { "12": ["a.ts"] },
  });
  const widgets = parseRefName("widgets");
  expect(await summarize(backend, widgets, created("main", "1"), alice)).toEqual({
    change: "widgets",
    parent: "main",
    owner: alice,
    reviewers: [],
    forgeChange: undefined,
    landed: undefined,
    base: fake("1"),
    tip: fake("2"),
    origin: "ahead",
    deadParent: undefined,
    staleBase: undefined,
    reviewLeft: ["a.ts"],
    nextStep: "review",
  });
});

test("a change whose parent has landed must reparent, review left or not", async () => {
  const opts = {
    history: { "1": "0", "2": "1" },
    branches: { main: "1", gadget: "1", "gadget-ui": "2" },
    changed: { "12": ["ui.ts"] },
    logs: { gadget: [...created("main", "0"), entry({ kind: "land", merge: fake("9") })] },
  };
  const ui = parseRefName("gadget-ui");
  expect(await summarize(repoBackend(opts), ui, created("gadget", "1"), alice)).toEqual({
    change: "gadget-ui",
    parent: "gadget",
    owner: alice,
    reviewers: [],
    forgeChange: undefined,
    landed: undefined,
    base: fake("1"),
    tip: fake("2"),
    origin: undefined,
    deadParent: "landed",
    staleBase: undefined,
    reviewLeft: ["ui.ts"],
    nextStep: "reparent",
  });
  // A disagreeing origin outranks even the dead parent, but both readings show.
  const behind = repoBackend({ ...opts, history: { "1": "0", "2": "1", "3": "2" }, origin: { "gadget-ui": "3" } });
  const summary = await summarize(behind, ui, created("gadget", "1"), alice);
  expect({ origin: summary.origin, deadParent: summary.deadParent, nextStep: summary.nextStep }).toEqual({
    origin: "behind",
    deadParent: "landed",
    nextStep: "sync",
  });
});

test("a change whose parent branch is gone must reparent", async () => {
  const backend = repoBackend({
    history: { "1": "0", "2": "1" },
    branches: { docs: "2" },
    changed: { "12": ["notes.md"] },
  });
  const docs = parseRefName("docs");
  expect(await summarize(backend, docs, created("gone", "1"), alice)).toEqual({
    change: "docs",
    parent: "gone",
    owner: alice,
    reviewers: [],
    forgeChange: undefined,
    landed: undefined,
    base: fake("1"),
    tip: fake("2"),
    origin: undefined,
    deadParent: "missing",
    staleBase: undefined,
    reviewLeft: ["notes.md"],
    nextStep: "reparent",
  });
});

test("a base under a rewritten parent reads as diverged, review still the step", async () => {
  // main was rewritten to 3 (forking from 0) while feature still builds on 1.
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "3": "0" },
    branches: { main: "3", feature: "2" },
    changed: { "12": ["a.ts"] },
  });
  expect(await summarize(backend, feature, created("main", "1"), alice)).toEqual({
    change: "feature",
    parent: "main",
    owner: alice,
    reviewers: [],
    forgeChange: undefined,
    landed: undefined,
    base: fake("1"),
    tip: fake("2"),
    origin: undefined,
    deadParent: undefined,
    staleBase: "diverged",
    reviewLeft: ["a.ts"],
    nextStep: "review",
  });
});

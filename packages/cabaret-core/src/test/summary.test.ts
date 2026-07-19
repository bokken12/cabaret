import { expect, test } from "vitest";
import {
  type Backend,
  type ChangeName,
  type ChangeSummary,
  changeDiff,
  changeForest,
  diffBetween,
  type FilePath,
  type FileView,
  forgeChangeId,
  type LogAction,
  type LogEntry,
  parseBranchName,
  parseCommitHash,
  parseFilePath,
  parseForgeLocator,
  type ReviewRound,
  type Revision,
  reviewRounds,
  summarizeChange,
  timestampMs,
  type UserName,
  userName,
} from "../index.js";

function refs(parents: Record<string, string>): ReadonlyMap<ChangeName, ChangeName> {
  return new Map(Object.entries(parents).map(([change, parent]) => [parseBranchName(change), parseBranchName(parent)]));
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
function fake(digit: string): Revision {
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
  merges?: readonly { change: string; commit: string; onto: string }[];
  changed?: Record<string, readonly string[]>;
  /** Conflicting paths by `<base><tip><onto>` digit triple, for `mergeConflicts`; an unanticipated triple is an error. */
  conflicting?: Record<string, readonly string[]>;
  /** File texts by commit digit, for `readFile`; an unlisted file reads as absent. */
  contents?: Record<string, Record<string, string>>;
  /** Second parents of merge commits, for `mergedTip`. */
  tips?: Record<string, string>;
  /** Origin's last-fetched branch tips, for `originTip`. */
  origin?: Record<string, string>;
  /** Commit digits whose objects this clone lacks, for `hasRevision`. */
  absent?: readonly string[];
  /** Change logs by name, for `readLog`; an unlisted name reads as empty. */
  logs?: Record<string, readonly LogEntry[]>;
}): Backend {
  const ancestry = (tip: Revision): Revision[] => {
    const chain = [tip];
    for (let up = opts.history[tip[0] as string]; up !== undefined; up = opts.history[up]) {
      chain.push(fake(up));
    }
    return chain;
  };
  const stub: Pick<
    Backend,
    | "mergedTip"
    | "mergedOnto"
    | "tip"
    | "originTip"
    | "hasRevision"
    | "mergeBase"
    | "isAncestor"
    | "landMerges"
    | "changedFiles"
    | "mergeConflicts"
    | "readFile"
    | "readLog"
  > = {
    async mergedTip(merge) {
      const digit = opts.tips?.[merge[0] as string];
      if (digit === undefined) {
        throw new Error(`unexpected mergedTip query: ${merge}`);
      }
      return fake(digit);
    },
    async mergedOnto(merge) {
      const digit = opts.history[merge[0] as string];
      if (digit === undefined) {
        throw new Error(`unexpected mergedOnto query: ${merge}`);
      }
      return fake(digit);
    },
    async tip(branch) {
      const digit = opts.branches[branch as string];
      return digit === undefined ? undefined : fake(digit);
    },
    async originTip(branch) {
      const digit = opts.origin?.[branch as string];
      return digit === undefined ? undefined : fake(digit);
    },
    async hasRevision(revision) {
      return !(opts.absent ?? []).includes(revision[0] as string);
    },
    async readLog(change) {
      return opts.logs?.[change as string] ?? [];
    },
    async mergeBase(a, b) {
      const shared = new Set(ancestry(b));
      const found = ancestry(a).find((commit) => shared.has(commit));
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
        .map(({ change, commit, onto }) => ({
          change: parseBranchName(change),
          commit: fake(commit),
          onto: fake(onto),
        }))
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
    async readFile(commit, file) {
      return opts.contents?.[commit[0] as string]?.[file as string];
    },
    async mergeConflicts(base, tip, onto) {
      const paths = opts.conflicting?.[`${base[0]}${tip[0]}${onto[0]}`];
      if (paths === undefined) {
        throw new Error(`unexpected mergeConflicts query: ${base[0]} ${tip[0]} ${onto[0]}`);
      }
      return paths.map(parseFilePath);
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
    entry({ kind: "set-parent", parent: parseBranchName(parent) }),
    entry({ kind: "set-base", base: fake(base) }),
    entry({ kind: "set-owner", owner: alice }),
  ];
}

function review(file: string, base: string, tip: string): LogAction {
  return { kind: "review", file: parseFilePath(file), base: fake(base), tip: fake(tip) };
}

const feature = parseBranchName("feature");

/** Summarize `change` with its diff read afresh from the log, as the pages do. */
async function summarize(
  backend: Backend,
  change: ChangeName,
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
  base: Revision,
  tip: Revision,
): Promise<readonly ReviewRound[]> {
  return reviewRounds(backend, entries, user, await diffBetween(backend, base, tip));
}

test("a change with no commits of its own must add code", async () => {
  const backend = repoBackend({ history: { "1": "0" }, branches: { main: "1", feature: "1" } });
  expect(await summarize(backend, feature, created("main", "1"), alice)).toEqual({
    kind: "change",
    change: "feature",
    parent: "main",
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: undefined,
    landed: undefined,
    included: [],
    archived: false,
    base: fake("1"),
    tip: fake("1"),
    origin: undefined,
    deadParent: undefined,
    parentOrigin: undefined,
    staleBase: undefined,
    conflicts: [],
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
    kind: "change",
    change: "feature",
    parent: "main",
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: undefined,
    landed: undefined,
    included: [],
    archived: false,
    base: fake("1"),
    tip: fake("3"),
    origin: undefined,
    deadParent: undefined,
    parentOrigin: undefined,
    staleBase: undefined,
    conflicts: [],
    reviewLeft: ["b.ts"],
    nextStep: "review",
  });
  // bob has reviewed nothing, so both files are left, sorted by name.
  expect(await summarize(backend, feature, entries, bob)).toEqual({
    kind: "change",
    change: "feature",
    parent: "main",
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: undefined,
    landed: undefined,
    included: [],
    archived: false,
    base: fake("1"),
    tip: fake("3"),
    origin: undefined,
    deadParent: undefined,
    parentOrigin: undefined,
    staleBase: undefined,
    conflicts: [],
    reviewLeft: ["a.ts", "b.ts"],
    nextStep: "review",
  });
});

test("a reviewed change conflicting with its parent's tip must rebase", async () => {
  // main advanced to 2 while feature (3-4) still forks from 1, and both
  // sides touched a.ts.
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "3": "1", "4": "3" },
    branches: { main: "2", feature: "4" },
    changed: { "14": ["a.ts"] },
    conflicting: { "142": ["a.ts"] },
  });
  const entries = [...created("main", "1"), entry(review("a.ts", "1", "4"))];
  expect(await summarize(backend, feature, entries, alice)).toEqual({
    kind: "change",
    change: "feature",
    parent: "main",
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: undefined,
    landed: undefined,
    included: [],
    archived: false,
    base: fake("1"),
    tip: fake("4"),
    origin: undefined,
    deadParent: undefined,
    parentOrigin: undefined,
    staleBase: "behind",
    conflicts: [],
    reviewLeft: [],
    nextStep: "rebase",
  });
});

test("a reviewed change whose parent trails origin reads through to origin's copy", async () => {
  // Origin's main moved to 5 while the local branch still sits at 2; the
  // local branch is a working position, so staleness and the conflict
  // dry-run read origin's fresher copy.
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "3": "1", "4": "3", "5": "2" },
    branches: { main: "2", feature: "4" },
    origin: { main: "5" },
    changed: { "14": ["a.ts"] },
    conflicting: { "145": [] },
  });
  const entries = [...created("main", "1"), entry(review("a.ts", "1", "4"))];
  expect(await summarize(backend, feature, entries, alice)).toEqual({
    kind: "change",
    change: "feature",
    parent: "main",
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: undefined,
    landed: undefined,
    included: [],
    archived: false,
    base: fake("1"),
    tip: fake("4"),
    origin: undefined,
    deadParent: undefined,
    parentOrigin: undefined,
    staleBase: "behind",
    conflicts: [],
    reviewLeft: [],
    nextStep: "land",
  });
});

test("a parent diverged from origin's copy is the user's to reconcile", async () => {
  // Local main was rewritten to 2 while origin's copy went to 5.
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "3": "1", "4": "3", "5": "1" },
    branches: { main: "2", feature: "4" },
    origin: { main: "5" },
    changed: { "14": ["a.ts"] },
  });
  const entries = [...created("main", "1"), entry(review("a.ts", "1", "4"))];
  expect(await summarize(backend, feature, entries, alice)).toEqual({
    kind: "change",
    change: "feature",
    parent: "main",
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: undefined,
    landed: undefined,
    included: [],
    archived: false,
    base: fake("1"),
    tip: fake("4"),
    origin: undefined,
    deadParent: undefined,
    parentOrigin: "diverged",
    staleBase: "behind",
    conflicts: [],
    reviewLeft: [],
    nextStep: "resolve parent divergence",
  });
});

test("a trailing parent reads through while review remains", async () => {
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "3": "1", "4": "3", "5": "2" },
    branches: { main: "2", feature: "4" },
    origin: { main: "5" },
    changed: { "14": ["a.ts"] },
  });
  expect(await summarize(backend, feature, created("main", "1"), alice)).toEqual({
    kind: "change",
    change: "feature",
    parent: "main",
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: undefined,
    landed: undefined,
    included: [],
    archived: false,
    base: fake("1"),
    tip: fake("4"),
    origin: undefined,
    deadParent: undefined,
    parentOrigin: undefined,
    staleBase: "behind",
    conflicts: [],
    reviewLeft: ["a.ts"],
    nextStep: "review",
  });
});

test("a parent absent locally reads as origin's copy, not dead", async () => {
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "3": "1", "4": "3" },
    branches: { feature: "4" },
    origin: { main: "2" },
    changed: { "14": ["a.ts"] },
    conflicting: { "142": [] },
  });
  const entries = [...created("main", "1"), entry(review("a.ts", "1", "4"))];
  expect(await summarize(backend, feature, entries, alice)).toEqual({
    kind: "change",
    change: "feature",
    parent: "main",
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: undefined,
    landed: undefined,
    included: [],
    archived: false,
    base: fake("1"),
    tip: fake("4"),
    origin: undefined,
    deadParent: undefined,
    parentOrigin: undefined,
    staleBase: "behind",
    conflicts: [],
    reviewLeft: [],
    nextStep: "land",
  });
});

test("a parent ahead of origin's copy is current: rebase proceeds on it", async () => {
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "3": "1", "4": "3" },
    branches: { main: "2", feature: "4" },
    origin: { main: "1" },
    changed: { "14": ["a.ts"] },
    conflicting: { "142": ["a.ts"] },
  });
  const entries = [...created("main", "1"), entry(review("a.ts", "1", "4"))];
  expect(await summarize(backend, feature, entries, alice)).toEqual({
    kind: "change",
    change: "feature",
    parent: "main",
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: undefined,
    landed: undefined,
    included: [],
    archived: false,
    base: fake("1"),
    tip: fake("4"),
    origin: undefined,
    deadParent: undefined,
    parentOrigin: undefined,
    staleBase: "behind",
    conflicts: [],
    reviewLeft: [],
    nextStep: "rebase",
  });
});

test("a reviewed change behind a parent it merges cleanly onto may land", async () => {
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "3": "1", "4": "3" },
    branches: { main: "2", feature: "4" },
    changed: { "14": ["b.ts"] },
    conflicting: { "142": [] },
  });
  const entries = [...created("main", "1"), entry(review("b.ts", "1", "4"))];
  expect(await summarize(backend, feature, entries, alice)).toEqual({
    kind: "change",
    change: "feature",
    parent: "main",
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: undefined,
    landed: undefined,
    included: [],
    archived: false,
    base: fake("1"),
    tip: fake("4"),
    origin: undefined,
    deadParent: undefined,
    parentOrigin: undefined,
    staleBase: "behind",
    conflicts: [],
    reviewLeft: [],
    nextStep: "land",
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
    kind: "change",
    change: "feature",
    parent: "main",
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: undefined,
    landed: undefined,
    included: [],
    archived: false,
    base: fake("1"),
    tip: fake("4"),
    origin: undefined,
    deadParent: undefined,
    parentOrigin: undefined,
    staleBase: undefined,
    conflicts: [],
    reviewLeft: [],
    nextStep: "land",
  });
});

test("a landed change reports its merge, and a moved-base review counts as left", async () => {
  // The branch is gone, as after post-land cleanup: the tip comes from the
  // land merge's second parent. Origin having moved on does not matter; the
  // change is frozen, so landed outranks every origin step.
  const backend = repoBackend({
    history: { "1": "0", "3": "1", "4": "3", "5": "1" },
    branches: { main: "5" },
    changed: { "14": ["b.ts", "a.ts"] },
    // The base's copy changed underneath the review, and differently from
    // the tip: the 4-way view is nonempty, so the stale review stays due.
    contents: { "0": { "a.ts": "old base\n" }, "1": { "a.ts": "new base\n" }, "4": { "a.ts": "tip\n" } },
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
    kind: "change",
    change: "feature",
    parent: "main",
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: { forge: "github.com/test-org/widgets", id: 7, staleParent: undefined },
    landed: fake("5"),
    included: [],
    archived: false,
    base: fake("1"),
    tip: fake("4"),
    origin: undefined,
    deadParent: undefined,
    parentOrigin: undefined,
    staleBase: undefined,
    conflicts: [],
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
    merges: [{ change: "gizmo", commit: "2", onto: "1" }],
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

test("reviewRounds counts a review against absent objects as no review at all", async () => {
  const backend = repoBackend({
    history: { "1": "0", "2": "1" },
    branches: { main: "0", feature: "2" },
    changed: { "02": ["a.ts", "b.ts"] },
    absent: ["8", "9"],
  });
  // a.ts was reviewed up to a tip, and b.ts against a base, that this clone
  // has no objects for; both count as unreviewed.
  const entries = [...created("main", "0"), entry(review("a.ts", "0", "9")), entry(review("b.ts", "8", "1"))];
  expect(await rounds(backend, entries, alice, fake("0"), fake("2"))).toEqual([
    {
      end: fake("2"),
      files: files({ "a.ts": { kind: "span", start: fake("0") }, "b.ts": { kind: "span", start: fake("0") } }),
    },
  ]);
});

test("reviewRounds carries misplaced reviews into the earliest round's view", async () => {
  // 2 is a land merge (onto 1). alice's review of a.ts predates the current
  // base, and her review of c.ts names a tip 9 that a rewrite removed from
  // history; both changed in both spans.
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "3": "2" },
    branches: { main: "0", feature: "3" },
    merges: [{ change: "gizmo", commit: "2", onto: "1" }],
    changed: { "01": ["a.ts", "c.ts"], "23": ["a.ts", "c.ts"], "93": ["c.ts"] },
    // Every version distinct, so neither carried view renders empty.
    contents: {
      "0": { "a.ts": "zero\n" },
      "1": { "a.ts": "one\n", "c.ts": "one\n" },
      "2": { "a.ts": "two\n" },
      "9": { "a.ts": "nine\n", "c.ts": "nine\n" },
    },
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

test("reviewRounds drops a rebased review whose file the base move left alone", async () => {
  // feature rebased from base 0 to base 1; a.ts reads the same at both bases
  // and at both tips, so nothing is left to read.
  const backend = repoBackend({
    history: { "1": "0", "3": "1" },
    branches: { main: "1", feature: "3" },
    changed: { "13": ["a.ts"] },
    contents: {
      "0": { "a.ts": "base\n" },
      "1": { "a.ts": "base\n" },
      "2": { "a.ts": "base\nplus\n" },
      "3": { "a.ts": "base\nplus\n" },
    },
  });
  const entries = [...created("main", "1"), entry(review("a.ts", "0", "2"))];
  expect(await rounds(backend, entries, alice, fake("1"), fake("3"))).toEqual([]);
});

test("reviewRounds drops a rebased review the rebase carried cleanly", async () => {
  // The base's copy gained a line, and the rebased tip took it verbatim: the
  // reviewed diff and the current diff agree, so the 4-way view is empty.
  const backend = repoBackend({
    history: { "1": "0", "3": "1" },
    branches: { main: "1", feature: "3" },
    changed: { "13": ["a.ts"] },
    contents: {
      "0": { "a.ts": "one\ntwo\n" },
      "1": { "a.ts": "zero\none\ntwo\n" },
      "2": { "a.ts": "one\ntwo\nthree\n" },
      "3": { "a.ts": "zero\none\ntwo\nthree\n" },
    },
  });
  const entries = [...created("main", "1"), entry(review("a.ts", "0", "2"))];
  expect(await rounds(backend, entries, alice, fake("1"), fake("3"))).toEqual([]);
});

test("reviewRounds keeps a rebased review whose diff the rebase changed", async () => {
  // The rebased tip resolves the base move differently from the reviewed
  // diff, so the 4-way view shows the disagreement.
  const backend = repoBackend({
    history: { "1": "0", "3": "1" },
    branches: { main: "1", feature: "3" },
    changed: { "13": ["a.ts"] },
    contents: {
      "0": { "a.ts": "one\n" },
      "1": { "a.ts": "uno\n" },
      "2": { "a.ts": "one\ntwo\n" },
      "3": { "a.ts": "uno\ndos\n" },
    },
  });
  const entries = [...created("main", "1"), entry(review("a.ts", "0", "2"))];
  expect(await rounds(backend, entries, alice, fake("1"), fake("3"))).toEqual([
    { end: fake("3"), files: files({ "a.ts": { kind: "rebased", reviewed: { base: fake("0"), tip: fake("2") } } }) },
  ]);
});

test("reviewRounds skips only the round a carried review leaves empty", async () => {
  // 2 is a land merge (onto 1). The rebase carried a.ts cleanly through the
  // first span, but the second span changed it again: only that span is due.
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "3": "2" },
    branches: { main: "0", feature: "3" },
    merges: [{ change: "gizmo", commit: "2", onto: "1" }],
    changed: { "01": ["a.ts"], "23": ["a.ts"] },
    contents: {
      "0": { "a.ts": "base\n" },
      "1": { "a.ts": "base\nplus\n" },
      "8": { "a.ts": "base\nplus\n" },
      "9": { "a.ts": "base\n" },
    },
  });
  const entries = [...created("main", "0"), entry(review("a.ts", "9", "8"))];
  expect(await rounds(backend, entries, alice, fake("0"), fake("3"))).toEqual([
    { end: fake("3"), files: files({ "a.ts": { kind: "span", start: fake("2") } }) },
  ]);
});

test("review left skips land merges and diffs from a rewritten reviewed tip", async () => {
  // 2 is a land merge (onto 1), so review spans 0-1 and 2-3. alice reviewed
  // a.ts through 2 (covering 0-1), and c.ts to a tip 9 that a rewrite removed
  // from history.
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "3": "2" },
    branches: { main: "0", feature: "3" },
    merges: [{ change: "gizmo", commit: "2", onto: "1" }],
    changed: { "01": ["a.ts", "c.ts"], "23": ["b.ts", "c.ts"], "93": ["c.ts"] },
    // c.ts differs from the rewritten reviewed tip, so its view stays due.
    contents: { "1": { "c.ts": "one\n" }, "9": { "c.ts": "nine\n" } },
  });
  const entries = [...created("main", "0"), entry(review("a.ts", "0", "2")), entry(review("c.ts", "0", "9"))];
  expect(await summarize(backend, feature, entries, alice)).toEqual({
    kind: "change",
    change: "feature",
    parent: "main",
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: undefined,
    landed: undefined,
    included: [{ change: "gizmo", commit: fake("2"), onto: fake("1") }],
    archived: false,
    base: fake("0"),
    tip: fake("3"),
    origin: undefined,
    deadParent: undefined,
    parentOrigin: undefined,
    staleBase: undefined,
    conflicts: [],
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
  const widgets = parseBranchName("widgets");
  expect(await summarize(backend, widgets, created("main", "1"), alice)).toEqual({
    kind: "change",
    change: "widgets",
    parent: "main",
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: undefined,
    landed: undefined,
    included: [],
    archived: false,
    base: fake("1"),
    tip: fake("1"),
    origin: "behind",
    deadParent: undefined,
    parentOrigin: undefined,
    staleBase: undefined,
    conflicts: [],
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
  const widgets = parseBranchName("widgets");
  expect(await summarize(backend, widgets, created("main", "1"), alice)).toEqual({
    kind: "change",
    change: "widgets",
    parent: "main",
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: undefined,
    landed: undefined,
    included: [],
    archived: false,
    base: fake("1"),
    tip: fake("3"),
    origin: "diverged",
    deadParent: undefined,
    parentOrigin: undefined,
    staleBase: undefined,
    conflicts: [],
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
  const widgets = parseBranchName("widgets");
  expect(await summarize(backend, widgets, created("main", "1"), alice)).toEqual({
    kind: "change",
    change: "widgets",
    parent: "main",
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: undefined,
    landed: undefined,
    included: [],
    archived: false,
    base: fake("1"),
    tip: fake("2"),
    origin: "ahead",
    deadParent: undefined,
    parentOrigin: undefined,
    staleBase: undefined,
    conflicts: [],
    reviewLeft: ["a.ts"],
    nextStep: "review",
  });
});

test("a change with no local branch reads origin's copy, with no origin note", async () => {
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "3": "2" },
    branches: { main: "1" },
    origin: { widgets: "3" },
    changed: { "13": ["a.ts", "b.ts"] },
  });
  const widgets = parseBranchName("widgets");
  expect(await summarize(backend, widgets, created("main", "1"), alice)).toEqual({
    kind: "change",
    change: "widgets",
    parent: "main",
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: undefined,
    landed: undefined,
    included: [],
    archived: false,
    base: fake("1"),
    tip: fake("3"),
    origin: undefined,
    deadParent: undefined,
    staleBase: undefined,
    conflicts: [],
    reviewLeft: ["a.ts", "b.ts"],
    nextStep: "review",
  });
});

test("a parent with no local branch reads as origin's copy, review still the step", async () => {
  // Origin's main moved to 2 under the change; no local main exists at all.
  const backend = repoBackend({
    history: { "2": "1", "3": "1" },
    branches: { feature: "3" },
    origin: { main: "2" },
    changed: { "13": ["a.ts"] },
  });
  expect(await summarize(backend, feature, created("main", "1"), alice)).toEqual({
    kind: "change",
    change: "feature",
    parent: "main",
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: undefined,
    landed: undefined,
    included: [],
    archived: false,
    base: fake("1"),
    tip: fake("3"),
    origin: undefined,
    deadParent: undefined,
    parentOrigin: undefined,
    staleBase: "behind",
    conflicts: [],
    reviewLeft: ["a.ts"],
    nextStep: "review",
  });
});

test("a stored base this clone lacks asks a reparent instead of failing the read", async () => {
  const backend = repoBackend({ history: { "3": "1" }, branches: { feature: "3" }, absent: ["1"] });
  await expect(summarize(backend, feature, created("main", "1"), alice)).rejects.toThrow(
    'parent branch of "feature" does not exist: "main"; run `cabaret reparent`',
  );
});

test("a reviewed forge-tracked change ahead of origin syncs before landing", async () => {
  // The tip moved to 3 locally while origin still holds 2: the forge cannot
  // land a tip it has not seen.
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "3": "2" },
    branches: { main: "1", gadget: "3" },
    origin: { gadget: "2" },
    changed: { "13": ["gadget.ts"] },
  });
  const gadget = parseBranchName("gadget");
  const entries = [
    ...created("main", "1"),
    entry({ kind: "set-forge", forge: parseForgeLocator("gitlab.com/test-org/gadgets"), id: forgeChangeId(12) }),
    entry(review("gadget.ts", "1", "3")),
  ];
  expect(await summarize(backend, gadget, entries, alice)).toEqual({
    kind: "change",
    change: "gadget",
    parent: "main",
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: { forge: "gitlab.com/test-org/gadgets", id: 12, staleParent: undefined },
    landed: undefined,
    included: [],
    archived: false,
    base: fake("1"),
    tip: fake("3"),
    origin: "ahead",
    deadParent: undefined,
    parentOrigin: undefined,
    staleBase: undefined,
    conflicts: [],
    reviewLeft: [],
    nextStep: "sync",
  });
});

test("a reviewed change ahead of origin with no forge change may land", async () => {
  // A local land reads nothing from origin, so unpushed commits block nothing.
  const backend = repoBackend({
    history: { "1": "0", "2": "1" },
    branches: { main: "1", docs: "2" },
    origin: { docs: "1" },
    changed: { "12": ["notes.md"] },
  });
  const docs = parseBranchName("docs");
  const entries = [...created("main", "1"), entry(review("notes.md", "1", "2"))];
  const summary = await summarize(backend, docs, entries, alice);
  expect({ origin: summary.origin, forgeChange: summary.forgeChange, nextStep: summary.nextStep }).toEqual({
    origin: "ahead",
    forgeChange: undefined,
    nextStep: "land",
  });
});

test("a forge-tracked change ahead of origin rebases before syncing when its parent conflicts", async () => {
  // main moved under the change and the merge conflicts: rewriting the tip
  // comes before publishing it.
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "5": "1", "6": "5" },
    branches: { main: "2", widgets: "6" },
    origin: { widgets: "5" },
    changed: { "16": ["w.ts"] },
    conflicting: { "162": ["w.ts"] },
  });
  const widgets = parseBranchName("widgets");
  const entries = [
    ...created("main", "1"),
    entry({ kind: "set-forge", forge: parseForgeLocator("github.com/test-org/widgets"), id: forgeChangeId(4) }),
    entry(review("w.ts", "1", "6")),
  ];
  const summary = await summarize(backend, widgets, entries, alice);
  expect({ origin: summary.origin, staleBase: summary.staleBase, nextStep: summary.nextStep }).toEqual({
    origin: "ahead",
    staleBase: "behind",
    nextStep: "rebase",
  });
});

test("a reviewed change whose forge change targets its old parent syncs to retarget", async () => {
  // Reparented from relic to main locally; the forge was last seen merging
  // into relic, and only publishing moves its target.
  const forge = parseForgeLocator("github.com/test-org/gizmos");
  const backend = repoBackend({
    history: { "1": "0", "2": "1" },
    branches: { main: "1", relic: "1", gizmo: "2" },
    origin: { gizmo: "2" },
    changed: { "12": ["gizmo.ts"] },
  });
  const gizmo = parseBranchName("gizmo");
  const entries = [
    ...created("relic", "1"),
    entry({ kind: "set-forge", forge, id: forgeChangeId(103) }),
    { ...entry({ kind: "set-parent", parent: parseBranchName("relic") }), source: { forge } },
    { ...entry({ kind: "set-parent", parent: parseBranchName("main") }), timestamp: timestampMs(1748000000001) },
    entry(review("gizmo.ts", "1", "2")),
  ];
  expect(await summarize(backend, gizmo, entries, alice)).toEqual({
    kind: "change",
    change: "gizmo",
    parent: "main",
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: { forge, id: 103, staleParent: "relic" },
    landed: undefined,
    included: [],
    archived: false,
    base: fake("1"),
    tip: fake("2"),
    origin: undefined,
    deadParent: undefined,
    parentOrigin: undefined,
    staleBase: undefined,
    conflicts: [],
    reviewLeft: [],
    nextStep: "sync",
  });
});

test("a change whose parent has landed must reparent, review left or not", async () => {
  const opts = {
    history: { "1": "0", "2": "1" },
    branches: { main: "1", gadget: "1", "gadget-ui": "2" },
    changed: { "12": ["ui.ts"] },
    logs: { gadget: [...created("main", "0"), entry({ kind: "land", merge: fake("9") })] },
  };
  const ui = parseBranchName("gadget-ui");
  expect(await summarize(repoBackend(opts), ui, created("gadget", "1"), alice)).toEqual({
    kind: "change",
    change: "gadget-ui",
    parent: "gadget",
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: undefined,
    landed: undefined,
    included: [],
    archived: false,
    base: fake("1"),
    tip: fake("2"),
    origin: undefined,
    deadParent: "landed",
    parentOrigin: undefined,
    staleBase: undefined,
    conflicts: [],
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
  const docs = parseBranchName("docs");
  expect(await summarize(backend, docs, created("gone", "1"), alice)).toEqual({
    kind: "change",
    change: "docs",
    parent: "gone",
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: undefined,
    landed: undefined,
    included: [],
    archived: false,
    base: fake("1"),
    tip: fake("2"),
    origin: undefined,
    deadParent: "missing",
    parentOrigin: undefined,
    staleBase: undefined,
    conflicts: [],
    reviewLeft: ["notes.md"],
    nextStep: "reparent",
  });
});

test("a base under a rewritten parent reads as diverged, review still the step", async () => {
  // main was rewritten to 3 (forking from 0) while feature still builds on 1.
  // No `conflicting` entry: with review left as the step, querying the
  // merge would be an unanticipated call the stub rejects.
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "3": "0" },
    branches: { main: "3", feature: "2" },
    changed: { "12": ["a.ts"] },
  });
  expect(await summarize(backend, feature, created("main", "1"), alice)).toEqual({
    kind: "change",
    change: "feature",
    parent: "main",
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: undefined,
    landed: undefined,
    included: [],
    archived: false,
    base: fake("1"),
    tip: fake("2"),
    origin: undefined,
    deadParent: undefined,
    parentOrigin: undefined,
    staleBase: "diverged",
    conflicts: [],
    reviewLeft: ["a.ts"],
    nextStep: "review",
  });
});

test("nextStep walks the staged reviewing flow", async () => {
  const backend = repoBackend({
    history: { "1": "0", "2": "1" },
    branches: { main: "1", feature: "2" },
    changed: { "12": ["a.ts"] },
  });
  const reviewing = (value: "none" | "owner" | "reviewers" | "everyone"): LogEntry =>
    entry({ kind: "set-reviewing", reviewing: value });
  const base = created("main", "1");
  const reviewed = entry(review("a.ts", "1", "2"));
  const step = async (entries: readonly LogEntry[]) => (await summarize(backend, feature, entries, alice)).nextStep;
  // A draft moves by widening, not by anyone reading it.
  expect(await step([...base, reviewing("none")])).toBe("widen reviewing");
  // The owner reviews first; done, they add reviewers when none exist to
  // widen to, and widen when some do.
  expect(await step([...base, reviewing("owner")])).toBe("review");
  expect(await step([...base, reviewing("owner"), reviewed])).toBe("add reviewers");
  expect(await step([...base, reviewing("owner"), reviewed, entry({ kind: "add-reviewer", reviewer: bob })])).toBe(
    "widen reviewing",
  );
  expect(await step([...base, reviewing("reviewers"), reviewed])).toBe("widen reviewing");
  expect(await step([...base, reviewing("everyone"), reviewed])).toBe("land");
});

test("an archived change reads as archived until the latest set-archived revives it", async () => {
  const backend = repoBackend({
    history: { "1": "0", "2": "1" },
    branches: { main: "1", feature: "2" },
    changed: { "12": ["a.ts"] },
  });
  const archive = (at: number, archived: boolean): LogEntry => ({
    timestamp: timestampMs(1748000000000 + at),
    user: alice,
    action: { kind: "set-archived", archived },
  });
  expect(await summarize(backend, feature, [...created("main", "1"), archive(1, true)], alice)).toEqual({
    kind: "change",
    change: "feature",
    parent: "main",
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: undefined,
    landed: undefined,
    included: [],
    archived: true,
    base: fake("1"),
    tip: fake("2"),
    origin: undefined,
    deadParent: undefined,
    staleBase: undefined,
    conflicts: [],
    reviewLeft: ["a.ts"],
    nextStep: "archived",
  });
  const revived = await summarize(
    backend,
    feature,
    [...created("main", "1"), archive(1, true), archive(2, false)],
    alice,
  );
  expect(revived.archived).toBe(false);
  expect(revived.nextStep).toBe("review");
});

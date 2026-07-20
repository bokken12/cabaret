import fc from "fast-check";
import { expect, test } from "vitest";
import {
  type Backend,
  type ChangeDiff,
  changeObligations,
  diffBetween,
  type FilePath,
  isReviewing,
  isSatisfied,
  type LogEntry,
  obligationStatuses,
  parseBranchName,
  parseCommitHash,
  parseFilePath,
  parseObligationsFile,
  type Revision,
  reviewerSummary,
  reviewOwed,
  type Self,
  soleUser,
  timestampMs,
  type UserName,
  userName,
} from "../index.js";

const alice = userName("alice@example.com");
const bob = userName("bob@example.com");
const carol = userName("carol@example.com");

/** A rule object as it appears in an `.obligations` file. */
function rule(match: string, atLeast: number, ...of: readonly string[]) {
  return { match, require: { atLeast, of } };
}

test("parseObligationsFile accepts the documented shape", () => {
  const text = JSON.stringify({
    root: true,
    rules: [rule("**/*.rs", 2, "alice@example.com", "bob@example.com", "carol@example.com")],
  });
  expect(parseObligationsFile(text)).toEqual({
    root: true,
    rules: [{ match: "**/*.rs", require: { atLeast: 2, of: [alice, bob, carol] } }],
  });
});

test("parseObligationsFile rejects vacuous and unsatisfiable requirements", () => {
  const parse =
    (atLeast: number, ...of: string[]) =>
    () =>
      parseObligationsFile(JSON.stringify({ rules: [rule("*.rs", atLeast, ...of)] }));
  expect(parse(0, "alice@example.com")).toThrow("expected number to be >0");
  expect(parse(3, "alice@example.com", "bob@example.com")).toThrow("`atLeast` asks for more reviewers than `of` lists");
  expect(parse(1, "alice@example.com", "alice@example.com")).toThrow("`of` lists a user twice");
  expect(parse(1)).toThrow();
});

test("parseObligationsFile rejects directory patterns and unknown keys", () => {
  expect(() => parseObligationsFile(JSON.stringify({ rules: [rule("vendor/", 1, "alice@example.com")] }))).toThrow(
    "patterns match files, not directories",
  );
  expect(() => parseObligationsFile(JSON.stringify({ rules: [], owner: "alice@example.com" }))).toThrow(
    /Unrecognized key: \\"owner\\"/,
  );
});

test("parseObligationsFile inverts JSON.stringify on any valid file", () => {
  const user = fc.emailAddress();
  const requirement = fc
    .uniqueArray(user, { minLength: 1, maxLength: 4 })
    .chain((of) => fc.integer({ min: 1, max: of.length }).map((atLeast) => ({ atLeast, of })));
  const file = fc.record(
    {
      root: fc.boolean(),
      rules: fc.array(
        fc.record({
          match: fc.stringMatching(/^[a-z*?[\]/.]+$/).filter((p) => p !== "" && !p.endsWith("/")),
          require: requirement,
        }),
        { maxLength: 4 },
      ),
    },
    { requiredKeys: ["rules"] },
  );
  fc.assert(
    fc.property(file, (value) => {
      expect(parseObligationsFile(JSON.stringify(value))).toEqual(value);
    }),
  );
});

/** The fake commit `digit.repeat(40)`, hex digits only. */
function fake(digit: string): Revision {
  return parseCommitHash(digit.repeat(40));
}

/**
 * A backend over fake one-digit commits. `trees` maps each commit to the
 * obligations files in its tree; `history` maps each commit to its first
 * parent; `changed` maps `<base><tip>` digit pairs to the files differing
 * between them, and a pair the test did not anticipate is an error. Only the
 * members obligations evaluation touches exist.
 */
function repoBackend(opts: {
  trees?: Record<string, Record<string, string>>;
  history?: Record<string, string>;
  changed?: Record<string, readonly string[]>;
  merges?: readonly { change?: string; commit: string; onto: string; merged?: string }[];
}): Backend {
  const ancestry = (tip: Revision): Revision[] => {
    const chain = [tip];
    for (let up = opts.history?.[tip[0] as string]; up !== undefined; up = opts.history?.[up]) {
      chain.push(fake(up));
    }
    return chain;
  };
  const stub: Pick<Backend, "readFile" | "changedFiles" | "chainMerges" | "isAncestor" | "hasRevision"> = {
    async hasRevision() {
      return true;
    },
    async readFile(commit, file) {
      return opts.trees?.[commit[0] as string]?.[file as string];
    },
    async changedFiles(base, tip) {
      if (base === tip) {
        return [];
      }
      const files = opts.changed?.[`${base[0]}${tip[0]}`];
      if (files === undefined) {
        throw new Error(`unexpected changedFiles query: ${base[0]}..${tip[0]}`);
      }
      return files.map((name) => ({ path: parseFilePath(name), source: undefined }));
    },
    async chainMerges(base, tip) {
      const path = ancestry(tip);
      const settled = base === undefined ? new Set<Revision>() : new Set(ancestry(base));
      const chain = path.filter((commit) => !settled.has(commit));
      const merges = (opts.merges ?? [])
        .map(({ change, commit, onto, merged }) => ({
          commit: fake(commit),
          onto: fake(onto),
          merged: merged === undefined ? undefined : fake(merged),
          landed: change === undefined ? undefined : parseBranchName(change),
        }))
        .filter(({ commit }) => chain.includes(commit))
        .sort((a, b) => path.indexOf(b.commit) - path.indexOf(a.commit));
      const oldest = chain.at(-1);
      const up = oldest === undefined ? undefined : opts.history?.[oldest[0] as string];
      return { merges, root: up === undefined ? undefined : fake(up), more: false };
    },
    async isAncestor(ancestor, descendant) {
      return ancestry(descendant).includes(ancestor);
    },
  };
  return stub as Backend;
}

/** `.obligations` file text with the given rules. */
function policyText(rules: readonly ReturnType<typeof rule>[], root?: boolean): string {
  return JSON.stringify(root === undefined ? { rules } : { root, rules });
}

function paths(names: readonly string[]): readonly FilePath[] {
  return names.map(parseFilePath);
}

/** The diff of the fake commits `base`..`tip`, read afresh. */
function diffOf(backend: Backend, base: string, tip: string): Promise<ChangeDiff> {
  return diffBetween(backend, fake(base), fake(tip));
}

test("obligations accumulate from every governing file, nearest first", async () => {
  const backend = repoBackend({
    trees: {
      "1": {
        ".obligations": policyText([rule("*.rs", 1, alice, bob)]),
        "crypto/.obligations": policyText([rule("**", 2, alice, bob, carol)]),
      },
    },
  });
  const files = paths(["crypto/keys.rs", "main.rs", "docs/notes.md"]);
  expect(await changeObligations(backend, fake("0"), fake("1"), files)).toEqual([
    { file: "crypto/keys.rs", source: "crypto/.obligations", require: { atLeast: 2, of: [alice, bob, carol] } },
    { file: "crypto/keys.rs", source: ".obligations", require: { atLeast: 1, of: [alice, bob] } },
    { file: "main.rs", source: ".obligations", require: { atLeast: 1, of: [alice, bob] } },
  ]);
});

test("a root obligations file cuts off its ancestors", async () => {
  const backend = repoBackend({
    trees: {
      "1": {
        ".obligations": policyText([rule("**", 1, alice)]),
        "vendor/.obligations": policyText([rule("*.gen.rs", 1, bob)], true),
      },
    },
  });
  const files = paths(["vendor/lib.gen.rs", "vendor/notes.md", "src/main.rs"]);
  expect(await changeObligations(backend, fake("0"), fake("1"), files)).toEqual([
    { file: "vendor/lib.gen.rs", source: "vendor/.obligations", require: { atLeast: 1, of: [bob] } },
    { file: "src/main.rs", source: ".obligations", require: { atLeast: 1, of: [alice] } },
  ]);
});

test("a pattern without a slash matches names at any depth; with a slash, the whole relative path", async () => {
  const backend = repoBackend({
    trees: {
      "1": {
        ".obligations": policyText([rule("*.rs", 1, alice), rule("sub/*.txt", 1, bob)]),
      },
    },
  });
  const files = paths(["deep/nested/lib.rs", "sub/a.txt", "sub/deep/b.txt", "other/sub/c.txt"]);
  expect(await changeObligations(backend, fake("0"), fake("1"), files)).toEqual([
    { file: "deep/nested/lib.rs", source: ".obligations", require: { atLeast: 1, of: [alice] } },
    { file: "sub/a.txt", source: ".obligations", require: { atLeast: 1, of: [bob] } },
  ]);
});

test("a changed obligations file carries its base version's requirements", async () => {
  const backend = repoBackend({
    trees: {
      "0": { "crypto/.obligations": policyText([rule("*.rs", 1, carol)]) },
      "1": {
        ".obligations": policyText([rule("**", 1, bob)]),
        "crypto/.obligations": policyText([rule("*.rs", 1, alice)]),
      },
    },
  });
  // The tip rules of crypto/.obligations do not match the file itself, but
  // the root policy does, and the replaced base version applies in full even
  // though its own pattern never matched the file either.
  expect(await changeObligations(backend, fake("0"), fake("1"), paths(["crypto/.obligations"]))).toEqual([
    { file: "crypto/.obligations", source: ".obligations", require: { atLeast: 1, of: [bob] } },
    { file: "crypto/.obligations", source: "crypto/.obligations", require: { atLeast: 1, of: [carol] } },
  ]);
});

test("a brand-new obligations file answers only to the tip tree", async () => {
  const backend = repoBackend({
    trees: { "1": { "a/.obligations": policyText([rule("**", 1, alice)]) } },
  });
  expect(await changeObligations(backend, fake("0"), fake("1"), paths(["a/.obligations"]))).toEqual([
    { file: "a/.obligations", source: "a/.obligations", require: { atLeast: 1, of: [alice] } },
  ]);
});

test("a malformed obligations file is a user error naming the file", async () => {
  const backend = repoBackend({ trees: { "1": { ".obligations": "not json" } } });
  await expect(changeObligations(backend, fake("0"), fake("1"), paths(["a.rs"]))).rejects.toThrow(
    'malformed obligations file ".obligations" at 111111111111',
  );
});

function review(user: UserName, file: string, base: string, tip: string): LogEntry {
  return {
    timestamp: timestampMs(1748000000000),
    user,
    action: { kind: "review", file: parseFilePath(file), base: fake(base), tip: fake(tip) },
  };
}

test("statuses count the users whose review covers the file", async () => {
  const backend = repoBackend({
    history: { "1": "0" },
    changed: { "01": ["keys.rs"] },
    trees: { "1": { ".obligations": policyText([rule("*.rs", 2, alice, bob, carol)]) } },
  });
  const entries = [review(alice, "keys.rs", "0", "1"), review(carol, "keys.rs", "0", "1")];
  const statuses = await obligationStatuses(backend, entries, alice, await diffOf(backend, "0", "1"));
  expect(statuses).toEqual([
    {
      obligation: { file: "keys.rs", source: "owner", require: { atLeast: 1, of: [alice] } },
      reviewedBy: [alice],
    },
    {
      obligation: { file: "keys.rs", source: ".obligations", require: { atLeast: 2, of: [alice, bob, carol] } },
      reviewedBy: [alice, carol],
    },
  ]);
  expect(statuses.map(isSatisfied)).toEqual([true, true]);
});

test("a review that stops short of the tip does not count", async () => {
  const backend = repoBackend({
    history: { "1": "0", "2": "1" },
    changed: { "02": ["a.rs"], "12": ["a.rs"] },
    trees: { "2": { ".obligations": policyText([rule("*.rs", 1, alice), rule("*.rs", 1, bob)]) } },
  });
  // alice reviewed to the tip; bob only to the middle commit, and a.rs
  // changed again after it.
  const entries = [review(alice, "a.rs", "0", "2"), review(bob, "a.rs", "0", "1")];
  const statuses = await obligationStatuses(backend, entries, alice, await diffOf(backend, "0", "2"));
  expect(statuses).toEqual([
    {
      obligation: { file: "a.rs", source: "owner", require: { atLeast: 1, of: [alice] } },
      reviewedBy: [alice],
    },
    {
      obligation: { file: "a.rs", source: ".obligations", require: { atLeast: 1, of: [alice] } },
      reviewedBy: [alice],
    },
    {
      obligation: { file: "a.rs", source: ".obligations", require: { atLeast: 1, of: [bob] } },
      reviewedBy: [],
    },
  ]);
  expect(statuses.map(isSatisfied)).toEqual([true, true, false]);
});

test("files changed only by a land merge carry no obligations", async () => {
  // 2 is a land merge (onto 1): whatever it brought in was reviewed in the
  // landed child, so only the spans 0-1 and 2-3 are governed here.
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "3": "2" },
    merges: [{ change: "gizmo", commit: "2", onto: "1" }],
    changed: { "01": ["a.rs"], "23": [] },
    trees: { "3": { ".obligations": policyText([rule("**", 1, alice)]) } },
  });
  const statuses = await obligationStatuses(backend, [], alice, await diffOf(backend, "0", "3"));
  expect(statuses.map(({ obligation }) => obligation.file)).toEqual(["a.rs", "a.rs"]);
  expect(statuses.map(isSatisfied)).toEqual([false, false]);
});

test("a rebase merge restarts the review window at the base it merged in", async () => {
  // The chain is work 1 then merge 2, which brought in 8 — the base, off the
  // chain since the parent moved 0 -> 8 under the change. The one span is the
  // current diff 8-2, resolutions included, not the stale window 0-1.
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "8": "0" },
    merges: [{ commit: "2", onto: "1", merged: "8" }],
    changed: { "82": ["a.rs"] },
  });
  const diff = await diffOf(backend, "8", "2");
  expect(diff.lands).toEqual([]);
  expect(diff.spans.map(({ start, end }) => [start[0], end[0]])).toEqual([["8", "2"]]);
});

test("a land cut pins the windows of rebase merges behind it to the chain", async () => {
  // Work 1, land 2, then rebase merges 3 and 4 as the parent moved 0 -> 8 -> 9.
  // Re-anchoring on the moved base would re-open the landed diff, so the one
  // governed span is the original window 0-1: neither the landed child's
  // files nor the parent's own movement owe review here.
  const backend = repoBackend({
    history: { "1": "0", "2": "1", "3": "2", "4": "3", "8": "0", "9": "8" },
    merges: [
      { change: "gizmo", commit: "2", onto: "1", merged: "c" },
      { commit: "3", onto: "2", merged: "8" },
      { commit: "4", onto: "3", merged: "9" },
    ],
    changed: { "01": ["a.rs"] },
  });
  const diff = await diffOf(backend, "9", "4");
  expect(diff.lands).toEqual([{ change: "gizmo", commit: fake("2"), onto: fake("1") }]);
  expect(diff.spans.map(({ start, end }) => [start[0], end[0]])).toEqual([["0", "1"]]);
  const statuses = await obligationStatuses(backend, [], alice, diff);
  expect(statuses).toEqual([
    { obligation: { file: "a.rs", source: "owner", require: { atLeast: 1, of: [alice] } }, reviewedBy: [] },
  ]);
});

test("reviewerSummary counts each outstanding reviewer's distinct files", () => {
  const status = (file: string, reviewedBy: readonly UserName[], atLeast: number, ...of: readonly UserName[]) => ({
    obligation: { file: parseFilePath(file), source: "owner" as const, require: { atLeast, of } },
    reviewedBy,
  });
  expect(reviewerSummary([])).toEqual([]);
  expect(
    reviewerSummary([
      status("src/keys.rs", [carol], 2, alice, bob, carol),
      status("src/lib.rs", [], 1, bob),
      status("src/lib.rs", [], 1, bob, carol),
    ]),
  ).toEqual(["alice@example.com: 1 file", "bob@example.com: 2 files", "carol@example.com: 1 file"]);
});

test("reviewOwed lists only files whose unsatisfied obligations await the user", async () => {
  const backend = repoBackend({
    history: { "1": "0" },
    changed: { "01": ["a.rs", "b.rs", "c.md"] },
    trees: { "1": { ".obligations": policyText([rule("*.rs", 1, bob, carol)]) } },
  });
  const entries = [review(alice, "a.rs", "0", "1"), review(carol, "a.rs", "0", "1")];
  const owed = async (self: Self) => reviewOwed(backend, entries, alice, self, await diffOf(backend, "0", "1"));
  // The rule on a.rs is already satisfied by carol, so it asks nothing more
  // of bob; the owner still owes the files only their self-review governs.
  expect(await owed(soleUser(bob))).toEqual(["b.rs"]);
  expect(await owed(soleUser(carol))).toEqual(["b.rs"]);
  expect(await owed(soleUser(alice))).toEqual(["b.rs", "c.md"]);
  // An alias's outstanding obligations count as the user's own; dan has none
  // of his own, so everything owed comes through the alias.
  expect(await owed({ user: userName("dan@example.com"), aliases: new Set([bob]) })).toEqual(["b.rs"]);
});

test("the owner must review every governed file, rules or none", async () => {
  const backend = repoBackend({
    history: { "1": "0" },
    changed: { "01": ["b.txt", "a.txt"] },
  });
  const entries = [review(alice, "a.txt", "0", "1"), review(bob, "b.txt", "0", "1")];
  const statuses = await obligationStatuses(backend, entries, alice, await diffOf(backend, "0", "1"));
  expect(statuses).toEqual([
    { obligation: { file: "a.txt", source: "owner", require: { atLeast: 1, of: [alice] } }, reviewedBy: [alice] },
    { obligation: { file: "b.txt", source: "owner", require: { atLeast: 1, of: [alice] } }, reviewedBy: [] },
  ]);
  expect(statuses.map(isSatisfied)).toEqual([true, false]);
});

function reviewer(user: UserName, kind: "add-reviewer" | "remove-reviewer", at = 1748000000000): LogEntry {
  return { timestamp: timestampMs(at), user: alice, action: { kind, reviewer: user } };
}

test("a reviewer owes every governed file, like the owner", async () => {
  const backend = repoBackend({
    history: { "1": "0" },
    changed: { "01": ["a.txt", "b.txt"] },
  });
  const entries = [reviewer(bob, "add-reviewer"), review(bob, "a.txt", "0", "1")];
  const statuses = await obligationStatuses(backend, entries, alice, await diffOf(backend, "0", "1"));
  expect(statuses).toEqual([
    { obligation: { file: "a.txt", source: "owner", require: { atLeast: 1, of: [alice] } }, reviewedBy: [] },
    { obligation: { file: "b.txt", source: "owner", require: { atLeast: 1, of: [alice] } }, reviewedBy: [] },
    { obligation: { file: "a.txt", source: "reviewer", require: { atLeast: 1, of: [bob] } }, reviewedBy: [bob] },
    { obligation: { file: "b.txt", source: "reviewer", require: { atLeast: 1, of: [bob] } }, reviewedBy: [] },
  ]);
  expect(statuses.map(isSatisfied)).toEqual([false, false, true, false]);
});

test("a removed reviewer owes nothing, and an owning reviewer owes only as owner", async () => {
  const backend = repoBackend({
    history: { "1": "0" },
    changed: { "01": ["a.txt"] },
  });
  const entries = [
    reviewer(alice, "add-reviewer"),
    reviewer(bob, "add-reviewer"),
    reviewer(bob, "remove-reviewer", 1748000000001),
  ];
  expect(await obligationStatuses(backend, entries, alice, await diffOf(backend, "0", "1"))).toEqual([
    { obligation: { file: "a.txt", source: "owner", require: { atLeast: 1, of: [alice] } }, reviewedBy: [] },
  ]);
});

test("isReviewing widens from nobody through the owner and reviewers to everyone", () => {
  const change = parseBranchName("feature");
  const at = (reviewing: "none" | "owner" | "reviewers" | "everyone", at: number): LogEntry => ({
    timestamp: timestampMs(at),
    user: alice,
    action: { kind: "set-reviewing", reviewing },
  });
  const base: LogEntry[] = [
    { timestamp: timestampMs(1748000000000), user: alice, action: { kind: "set-owner", owner: alice } },
    reviewer(bob, "add-reviewer"),
  ];
  const dan = userName("dan@example.com");
  const membership = (entries: readonly LogEntry[]) =>
    [alice, bob, carol].map((user) => isReviewing(soleUser(user), change, entries));
  // A log that never set a reviewing set reads as everyone.
  expect(membership(base)).toEqual([true, true, true]);
  expect(membership([...base, at("none", 1748000000001)])).toEqual([false, false, false]);
  expect(membership([...base, at("owner", 1748000000001)])).toEqual([true, false, false]);
  expect(membership([...base, at("reviewers", 1748000000001)])).toEqual([true, true, false]);
  expect(membership([...base, at("everyone", 1748000000001)])).toEqual([true, true, true]);
  // The latest entry wins, and an alias of a member is a member.
  const narrowed = [...base, at("everyone", 1748000000001), at("owner", 1748000000002)];
  expect(membership(narrowed)).toEqual([true, false, false]);
  expect(isReviewing({ user: dan, aliases: new Set([alice]) }, change, narrowed)).toBe(true);
});

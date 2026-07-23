import fc from "fast-check";
import { expect, test } from "vitest";
import {
  type Backend,
  type ChangedFile,
  type ChangeName,
  type FileMode,
  forgeChangeId,
  parseBranchName,
  parseCommitHash,
  parseFileMode,
  parseFilePath,
  parseForgeLocator,
  REVIEWING,
  type RefSnapshot,
  type Revision,
  type UserName,
  userName,
} from "../backend.js";
import {
  cachedChangeReading,
  formatReadingEntry,
  parseReadingEntry,
  type ReadingEntry,
  readingCurrent,
} from "../reading.js";
import type { Self } from "../self.js";
import { type ChangeSummary, NEXT_STEPS } from "../summary.js";

function refNames(): fc.Arbitrary<ChangeName> {
  const valid = (raw: string): boolean => {
    try {
      parseBranchName(raw);
      return true;
    } catch {
      return false;
    }
  };
  return fc.string({ minLength: 1, maxLength: 30, unit: "grapheme" }).filter(valid).map(parseBranchName);
}

function filePaths() {
  return fc
    .string({ minLength: 1, unit: "grapheme" })
    .filter((raw) => !raw.includes("\0"))
    .map(parseFilePath);
}

function commitHashes(): fc.Arbitrary<Revision> {
  return fc.string({ unit: fc.constantFrom(..."0123456789abcdef"), minLength: 40, maxLength: 40 }).map(parseCommitHash);
}

function users(): fc.Arbitrary<UserName> {
  return fc.string({ minLength: 1, unit: "grapheme" }).map(userName);
}

function fileModes(): fc.Arbitrary<FileMode> {
  return fc.constantFrom("100644", "100755", "120000").map(parseFileMode);
}

function maybe<T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> {
  return fc.option(arb, { nil: undefined });
}

function changedFiles(): fc.Arbitrary<ChangedFile> {
  return fc.record({
    path: filePaths(),
    source: maybe(fc.record({ path: filePaths(), copied: fc.boolean() })),
    modes: maybe(fc.record({ prev: fileModes(), next: fileModes() })),
  });
}

function summaries(): fc.Arbitrary<ChangeSummary> {
  return fc.record({
    kind: fc.constant("change" as const),
    change: refNames(),
    parent: refNames(),
    owner: users(),
    reviewers: fc.array(users()),
    reviewing: fc.constantFrom(...REVIEWING),
    forgeChange: maybe(
      fc.record({
        forge: fc.string({ minLength: 1, unit: "grapheme" }).map(parseForgeLocator),
        id: fc.integer({ min: 1 }).map(forgeChangeId),
        staleParent: maybe(refNames()),
      }),
    ),
    landed: maybe(commitHashes()),
    included: fc.array(fc.record({ change: refNames(), commit: commitHashes(), onto: commitHashes() })),
    archived: fc.boolean(),
    permanent: fc.boolean(),
    base: commitHashes(),
    tip: commitHashes(),
    origin: maybe(fc.constantFrom("ahead" as const, "behind" as const, "diverged" as const)),
    deadParent: maybe(fc.constantFrom("landed" as const, "missing" as const, "archived" as const)),
    parentOrigin: maybe(fc.constant("diverged" as const)),
    staleBase: maybe(fc.constantFrom("behind" as const, "diverged" as const)),
    conflicts: fc.array(filePaths()),
    reviewLeft: fc.array(changedFiles()),
    nextStep: fc.constantFrom(...NEXT_STEPS),
  });
}

function readMaps(): fc.Arbitrary<ReadonlyMap<ChangeName, Revision | undefined>> {
  return fc
    .uniqueArray(fc.tuple(refNames(), maybe(commitHashes())), { selector: ([name]) => name })
    .map((pairs) => new Map(pairs));
}

function entries(): fc.Arbitrary<ReadingEntry> {
  return fc.record({
    change: refNames(),
    user: users(),
    aliases: fc.uniqueArray(users()).map((aliases) => [...aliases].sort()),
    reads: fc.record({
      heads: readMaps(),
      origins: readMaps(),
      logs: readMaps(),
      absent: fc.uniqueArray(commitHashes()).map((revisions) => new Set(revisions)),
    }),
    summary: summaries(),
    owed: fc.array(filePaths()),
  });
}

test("reading entries round-trip through their wire format", () => {
  fc.assert(
    fc.property(entries(), (entry) => {
      expect(parseReadingEntry(formatReadingEntry(entry))).toEqual(entry);
    }),
  );
});

test("reads of prototype-named refs survive the wire format", () => {
  const traps = ["__proto__", "constructor", "toString"].map(parseBranchName);
  const entry: ReadingEntry = {
    ...featureEntry(),
    change: traps[0] as ChangeName,
    reads: {
      heads: new Map(traps.map((name, index) => [name, fake(String(index))])),
      origins: new Map([[traps[0] as ChangeName, undefined]]),
      logs: new Map(traps.map((name) => [name, fake("c")])),
      absent: new Set(),
    },
  };
  expect(parseReadingEntry(formatReadingEntry(entry))).toEqual(entry);
});

test("garbage and other versions' entries read as absent", () => {
  const stored = fc.sample(entries(), { numRuns: 1, seed: 7 })[0];
  if (stored === undefined) {
    throw new Error("no sample");
  }
  const raw = formatReadingEntry(stored);
  expect(parseReadingEntry(`${JSON.stringify({ ...JSON.parse(raw), version: 999 })}`)).toBeUndefined();
  expect(parseReadingEntry("not json")).toBeUndefined();
  expect(parseReadingEntry("{}")).toBeUndefined();
  expect(parseReadingEntry(raw.slice(0, raw.length / 2))).toBeUndefined();
});

function fake(digit: string): Revision {
  return parseCommitHash(digit.repeat(40));
}

const feature = parseBranchName("feature");
const main = parseBranchName("main");
const alice = userName("alice@example.com");
const agent = userName("agent@example.com");

function featureSummary(): ChangeSummary {
  return {
    kind: "change",
    change: feature,
    parent: main,
    owner: alice,
    reviewers: [],
    reviewing: "everyone",
    forgeChange: undefined,
    landed: undefined,
    included: [],
    archived: false,
    permanent: false,
    base: fake("b"),
    tip: fake("a"),
    origin: undefined,
    deadParent: undefined,
    parentOrigin: undefined,
    staleBase: undefined,
    conflicts: [],
    reviewLeft: [],
    nextStep: "review",
  };
}

function featureEntry(): ReadingEntry {
  return {
    change: feature,
    user: alice,
    aliases: [agent],
    reads: {
      heads: new Map([
        [feature, fake("a")],
        [main, fake("b")],
      ]),
      origins: new Map([[feature, undefined]]),
      logs: new Map([[feature, fake("c")]]),
      absent: new Set([fake("d")]),
    },
    summary: featureSummary(),
    owed: [parseFilePath("x.ts")],
  };
}

function featureSnapshot(): RefSnapshot {
  return {
    heads: new Map([
      [feature, fake("a")],
      [main, fake("b")],
    ]),
    origins: new Map(),
    logs: new Map([[feature, fake("c")]]),
  };
}

const self: Self = { user: alice, aliases: new Set([agent]) };

test("a reading is current exactly while its recorded reads hold for its identity", () => {
  const entry = featureEntry();
  expect(readingCurrent(entry, featureSnapshot(), self, feature)).toBe(true);

  // Refs the reading never read move freely without unseating it.
  const grown = featureSnapshot();
  (grown.heads as Map<ChangeName, Revision>).set(parseBranchName("elsewhere"), fake("e"));
  (grown.origins as Map<ChangeName, Revision>).set(main, fake("e"));
  expect(readingCurrent(entry, grown, self, feature)).toBe(true);

  // Any recorded read answering differently unseats it: a moved branch, an
  // origin copy appearing where none was, a log growing an entry.
  const movedHead = featureSnapshot();
  (movedHead.heads as Map<ChangeName, Revision>).set(feature, fake("e"));
  expect(readingCurrent(entry, movedHead, self, feature)).toBe(false);
  const appearedOrigin = featureSnapshot();
  (appearedOrigin.origins as Map<ChangeName, Revision>).set(feature, fake("e"));
  expect(readingCurrent(entry, appearedOrigin, self, feature)).toBe(false);
  const movedLog = featureSnapshot();
  (movedLog.logs as Map<ChangeName, Revision>).set(feature, fake("e"));
  expect(readingCurrent(entry, movedLog, self, feature)).toBe(false);
  const goneHead = featureSnapshot();
  (goneHead.heads as Map<ChangeName, Revision>).delete(feature);
  expect(readingCurrent(entry, goneHead, self, feature)).toBe(false);

  // Another identity's reading never answers: another user, a changed alias
  // set, or a same-keyed file holding some other change's entry.
  expect(readingCurrent(entry, featureSnapshot(), { user: agent, aliases: new Set() }, feature)).toBe(false);
  expect(readingCurrent(entry, featureSnapshot(), { user: alice, aliases: new Set() }, feature)).toBe(false);
  expect(
    readingCurrent(entry, featureSnapshot(), { user: alice, aliases: new Set([agent, userName("bot")]) }, feature),
  ).toBe(false);
  expect(readingCurrent(entry, featureSnapshot(), self, main)).toBe(false);
});

/** A backend whose cache holds `entry` and whose object store answers `has`; any other read recomputes loudly. */
function cacheBackend(entry: ReadingEntry, has: (revision: Revision) => boolean): Backend {
  const stub: Pick<Backend, "readCache" | "hasRevision" | "readLogAt" | "writeCache"> = {
    async readCache(key) {
      expect(key).toBe("summary/alice%40example%2Ecom/feature.json");
      return formatReadingEntry(entry);
    },
    async hasRevision(revision) {
      return has(revision);
    },
    async readLogAt() {
      throw new Error("recomputed");
    },
    async writeCache() {
      throw new Error("recomputed");
    },
  };
  return stub as Backend;
}

test("a current reading answers from the cache without recomputing", async () => {
  const entry = featureEntry();
  const backend = cacheBackend(entry, () => false);
  expect(await cachedChangeReading(backend, featureSnapshot(), self, feature)).toEqual({
    summary: entry.summary,
    owed: entry.owed,
  });
});

test("a probed-absent revision appearing forces a recompute", async () => {
  const backend = cacheBackend(featureEntry(), (revision) => revision === fake("d"));
  await expect(cachedChangeReading(backend, featureSnapshot(), self, feature)).rejects.toThrow("recomputed");
});

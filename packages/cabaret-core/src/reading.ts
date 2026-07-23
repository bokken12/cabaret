import { mapConcurrent } from "cabaret-util";
import { z } from "zod";
import {
  type Backend,
  type ChangedFile,
  type ChangeName,
  changeDiff,
  type FilePath,
  type FileSource,
  forgeChangeId,
  type ModeChange,
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
} from "./backend.js";
import { UserError } from "./error.js";
import { isReviewing, reviewOwed } from "./obligations.js";
import { pinBackend, type RefReads } from "./pinned.js";
import { currentSelf, type Self } from "./self.js";
import { type ChangeSummary, NEXT_STEPS, summarizeChange } from "./summary.js";

/** One change's readings for a page: its summary, and what review it asks of the user. */
export interface ChangeReading {
  readonly summary: ChangeSummary;
  /** The files with an unsatisfied obligation the user's review can still count toward, sorted by name. */
  readonly owed: readonly FilePath[];
}

/** Read `change` whole for `self`: its summary, and the review it asks of them. */
export async function changeReading(backend: Backend, self: Self, change: ChangeName): Promise<ChangeReading> {
  const entries = await backend.readLog(change);
  const diff = await changeDiff(backend, change, entries);
  const summary = await summarizeChange(backend, change, entries, self.user, diff);
  // Obligations ask nothing of a user outside the reviewing set — a
  // membership the log alone decides, sparing the obligations files of
  // most changes. An empty reviewLeft already counts the user toward
  // every obligation — though it says nothing about their aliases, whose
  // obligations each count that identity's own reviews. A change with
  // conflict markers asks review of nobody: fixing them rewrites the
  // tip, so reading it now is wasted. A landed change still asks, archived
  // with the land or not: the follow review its landing left in place
  // stays owed until reviewers catch up.
  const asked =
    (!summary.archived || summary.landed !== undefined) &&
    summary.conflicts.length === 0 &&
    (summary.reviewLeft.length > 0 || self.aliases.size > 0) &&
    isReviewing(self, change, entries);
  return { summary, owed: asked ? await reviewOwed(backend, entries, summary.owner, self, diff) : [] };
}

/**
 * A cached `ChangeReading` and everything proving it current: who it was
 * computed for — obligations and review-left are per identity — and the
 * reads of mutable state the computation made, as `RefReads`. The reading
 * holds exactly while those reads would answer the same, so a holder
 * validates against a fresh `RefSnapshot` (and re-probes the absent
 * revisions) instead of recomputing.
 */
export interface ReadingEntry {
  readonly change: ChangeName;
  readonly user: UserName;
  /** The user's aliases when the reading was computed, sorted by name. */
  readonly aliases: readonly UserName[];
  readonly reads: RefReads;
  readonly summary: ChangeSummary;
  readonly owed: readonly FilePath[];
}

/**
 * Bump when a reading's meaning changes — a summary field added or removed,
 * a derivation fixed — so entries other versions wrote read as absent
 * rather than as answers they no longer are.
 */
const READING_CACHE_VERSION = 1;

const RevisionSchema = z.string().transform(parseCommitHash);
const NameSchema = z.string().transform(parseBranchName);
const UserSchema = z.string().min(1).transform(userName);
const FileSchema = z.string().transform(parseFilePath);

/** JSON has no undefined, so an absent value is stored as an explicit null. */
const nullable = <Schema extends z.ZodType>(schema: Schema) =>
  z.union([schema, z.null()]).transform((value): z.output<Schema> | undefined => value ?? undefined);

const FileSourceSchema = z.strictObject({
  path: FileSchema,
  copied: z.boolean(),
}) satisfies z.ZodType<FileSource>;

const ModeChangeSchema = z.strictObject({
  prev: z.string().transform(parseFileMode),
  next: z.string().transform(parseFileMode),
}) satisfies z.ZodType<ModeChange>;

const ChangedFileSchema = z.strictObject({
  path: FileSchema,
  source: nullable(FileSourceSchema),
  modes: nullable(ModeChangeSchema),
}) satisfies z.ZodType<ChangedFile>;

const SummarySchema = z.strictObject({
  kind: z.literal("change"),
  change: NameSchema,
  parent: NameSchema,
  owner: UserSchema,
  reviewers: z.array(UserSchema),
  reviewing: z.enum(REVIEWING),
  forgeChange: nullable(
    z.strictObject({
      forge: z.string().transform(parseForgeLocator),
      id: z.number().transform(forgeChangeId),
      staleParent: nullable(NameSchema),
    }),
  ),
  landed: nullable(RevisionSchema),
  included: z.array(z.strictObject({ change: NameSchema, commit: RevisionSchema, onto: RevisionSchema })),
  archived: z.boolean(),
  permanent: z.boolean(),
  base: RevisionSchema,
  tip: RevisionSchema,
  origin: nullable(z.enum(["ahead", "behind", "diverged"])),
  deadParent: nullable(z.enum(["landed", "missing", "archived"])),
  parentOrigin: nullable(z.literal("diverged")),
  staleBase: nullable(z.enum(["behind", "diverged"])),
  conflicts: z.array(FileSchema),
  reviewLeft: z.array(ChangedFileSchema),
  nextStep: z.enum(NEXT_STEPS),
}) satisfies z.ZodType<ChangeSummary>;

const ReadsSchema = z
  .record(z.string(), z.union([z.string(), z.null()]))
  .transform(
    (record) =>
      new Map(
        Object.entries(record).map(([name, hash]) => [
          parseBranchName(name),
          hash === null ? undefined : parseCommitHash(hash),
        ]),
      ),
  );

const RefReadsSchema = z.strictObject({
  heads: ReadsSchema,
  origins: ReadsSchema,
  logs: ReadsSchema,
  absent: z.array(RevisionSchema).transform((revisions) => new Set(revisions)),
}) satisfies z.ZodType<RefReads>;

const ReadingEntrySchema = z
  .strictObject({
    version: z.literal(READING_CACHE_VERSION),
    change: NameSchema,
    user: UserSchema,
    aliases: z.array(UserSchema),
    reads: RefReadsSchema,
    summary: SummarySchema,
    owed: z.array(FileSchema),
  })
  .transform(({ version: _, ...entry }) => entry) satisfies z.ZodType<ReadingEntry>;

/**
 * Parse a stored entry, or undefined for anything else: garbage, another
 * version's entry, a torn write. An unreadable entry is not an error
 * anywhere — the reading recomputes as if nothing were stored — so nothing
 * is worth surfacing.
 */
export function parseReadingEntry(raw: string): ReadingEntry | undefined {
  try {
    return ReadingEntrySchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function formatReadingEntry(entry: ReadingEntry): string {
  const reads = (map: ReadonlyMap<ChangeName, Revision | undefined>) =>
    Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, hash]) => [name, hash ?? null]));
  const { summary } = entry;
  return JSON.stringify({
    version: READING_CACHE_VERSION,
    change: entry.change,
    user: entry.user,
    aliases: entry.aliases,
    reads: {
      heads: reads(entry.reads.heads),
      origins: reads(entry.reads.origins),
      logs: reads(entry.reads.logs),
      absent: [...entry.reads.absent].sort(),
    },
    summary: {
      ...summary,
      forgeChange:
        summary.forgeChange === undefined
          ? null
          : { ...summary.forgeChange, staleParent: summary.forgeChange.staleParent ?? null },
      landed: summary.landed ?? null,
      origin: summary.origin ?? null,
      deadParent: summary.deadParent ?? null,
      parentOrigin: summary.parentOrigin ?? null,
      staleBase: summary.staleBase ?? null,
      reviewLeft: summary.reviewLeft.map((file) => ({
        path: file.path,
        source: file.source ?? null,
        modes: file.modes ?? null,
      })),
    },
    owed: entry.owed,
  });
}

/**
 * Whether `entry` still answers for `change` read by `self` under
 * `snapshot`: computed by the same identity — the change's own name
 * included, lest two names one filesystem folds together trade entries —
 * with every recorded ref read answering exactly as it did. Absent
 * revisions are the one read this cannot see; `heldReading` re-probes them.
 */
export function readingCurrent(entry: ReadingEntry, snapshot: RefSnapshot, self: Self, change: ChangeName): boolean {
  const holds = (reads: ReadonlyMap<ChangeName, Revision | undefined>, pinned: ReadonlyMap<ChangeName, Revision>) =>
    [...reads].every(([name, revision]) => pinned.get(name) === revision);
  return (
    entry.change === change &&
    entry.user === self.user &&
    entry.aliases.length === self.aliases.size &&
    entry.aliases.every((alias) => self.aliases.has(alias)) &&
    holds(entry.reads.heads, snapshot.heads) &&
    holds(entry.reads.origins, snapshot.origins) &&
    holds(entry.reads.logs, snapshot.logs)
  );
}

/** Percent-encode `raw` into one path segment: only [A-Za-z0-9_-] survives. */
function encodeSegment(raw: string): string {
  return encodeURIComponent(raw).replace(
    /[.!~*'()]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/** Where `change`'s reading for `user` is cached. */
function readingKey(user: UserName, change: ChangeName): string {
  return `summary/${encodeSegment(user)}/${encodeSegment(change)}.json`;
}

/** The cached reading of `change` for `self`, when one is stored and still current. */
async function heldReading(
  backend: Backend,
  snapshot: RefSnapshot,
  self: Self,
  change: ChangeName,
): Promise<ChangeReading | undefined> {
  const stored = await backend.readCache(readingKey(self.user, change));
  const entry = stored === undefined ? undefined : parseReadingEntry(stored);
  if (entry === undefined || !readingCurrent(entry, snapshot, self, change)) {
    return undefined;
  }
  // A probe that found nothing is the one recorded read a snapshot cannot
  // answer: an object since fetched changes what reviews count, so it
  // re-probes here. Presence is monotone, so probes that found their object
  // are not recorded and need no recheck.
  for (const revision of entry.reads.absent) {
    if (await backend.hasRevision(revision)) {
      return undefined;
    }
  }
  return { summary: entry.summary, owed: entry.owed };
}

/**
 * `changeReading` through the persistent cache: a stored reading whose
 * recorded reads still hold under `snapshot` answers directly; anything
 * else recomputes pinned at the snapshot and stores the result, keyed by
 * the reads the computation actually made. A reading that fails to compute
 * (a `UserError` names the change broken) stores nothing.
 */
export async function cachedChangeReading(
  backend: Backend,
  snapshot: RefSnapshot,
  self: Self,
  change: ChangeName,
): Promise<ChangeReading> {
  const held = await heldReading(backend, snapshot, self, change);
  if (held !== undefined) {
    return held;
  }
  const pinned = pinBackend(backend, snapshot);
  const reading = await changeReading(pinned.backend, self, change);
  await backend.writeCache(
    readingKey(self.user, change),
    formatReadingEntry({
      change,
      user: self.user,
      aliases: [...self.aliases].sort(),
      reads: pinned.reads,
      summary: reading.summary,
      owed: reading.owed,
    }),
  );
  return reading;
}

/** Readings recomputed at once while warming, matching what pages read at. */
const WARM_CONCURRENCY = 8;

/**
 * Bring the reading cache fully current for the current user: recompute and
 * store every change's reading whose entry no longer answers, and drop the
 * entries — any user's — of changes that no longer exist. Fetch warms after
 * moving refs, so pages pay for what a fetch moved as it lands rather than
 * on their next view. A change whose reading fails to compute (a
 * `UserError`, read as broken wherever it shows) has nothing to store and
 * does not interrupt the rest.
 */
export async function warmReadings(backend: Backend): Promise<void> {
  const self = await currentSelf(backend);
  const snapshot = await backend.refSnapshot();
  await mapConcurrent([...snapshot.logs.keys()], WARM_CONCURRENCY, async (change) => {
    try {
      await cachedChangeReading(backend, snapshot, self, change);
    } catch (error) {
      if (!(error instanceof UserError)) {
        throw error;
      }
    }
  });
  for (const key of await backend.listCache("summary")) {
    const change = keyChange(key);
    if (change === undefined || !snapshot.logs.has(change)) {
      await backend.deleteCache(key);
    }
  }
}

/** The change named by a reading key, or undefined for anything else stored under the prefix. */
function keyChange(key: string): ChangeName | undefined {
  const segments = key.split("/");
  const last = segments[2];
  if (segments.length !== 3 || last === undefined || !last.endsWith(".json")) {
    return undefined;
  }
  try {
    return parseBranchName(decodeURIComponent(last.slice(0, -".json".length)));
  } catch {
    return undefined;
  }
}

import picomatch from "picomatch/posix.js";
import { z } from "zod";
import {
  type Backend,
  type ChangeDiff,
  type ChangeName,
  currentOwner,
  currentReviewers,
  currentReviewing,
  type FilePath,
  type LogEntry,
  landedMerge,
  parseFilePath,
  type Reviewing,
  type Revision,
  type UserName,
  userName,
} from "./backend.js";
import { UserError } from "./error.js";
import { currentSelf, isSelf, type Self } from "./self.js";
import { reviewRound } from "./summary.js";

/** The name of the obligations file each directory may contain. */
export const OBLIGATIONS_FILE = ".obligations";

/** A demand that some of a set of users review a file. */
export interface Requirement {
  /** How many distinct users of `of` must review. */
  readonly atLeast: number;
  /** The users who may satisfy the demand, without duplicates. */
  readonly of: readonly UserName[];
}

/** One rule of an obligations file: the requirement it puts on matching files. */
export interface ObligationRule {
  /** A gitignore-style pattern, relative to the directory containing the file. */
  readonly match: string;
  readonly require: Requirement;
}

/** The contents of one `.obligations` file. */
export interface ObligationsFile {
  /** When true, obligations files in ancestor directories do not govern this subtree. */
  readonly root?: boolean | undefined;
  readonly rules: readonly ObligationRule[];
}

const RequirementSchema = z
  .strictObject({
    atLeast: z.number().int().positive(),
    of: z.array(z.string().min(1).transform(userName)).min(1),
  })
  .refine((require) => new Set(require.of).size === require.of.length, { error: "`of` lists a user twice" })
  .refine((require) => require.atLeast <= require.of.length, {
    error: "`atLeast` asks for more reviewers than `of` lists",
  }) satisfies z.ZodType<Requirement>;

const ObligationRuleSchema = z.strictObject({
  match: z
    .string()
    .min(1)
    .refine((pattern) => !pattern.endsWith("/"), { error: "patterns match files, not directories" }),
  require: RequirementSchema,
}) satisfies z.ZodType<ObligationRule>;

const ObligationsFileSchema = z.strictObject({
  root: z.boolean().optional(),
  rules: z.array(ObligationRuleSchema),
}) satisfies z.ZodType<ObligationsFile>;

/** Parse the JSON text of an `.obligations` file. */
export function parseObligationsFile(text: string): ObligationsFile {
  return ObligationsFileSchema.parse(JSON.parse(text));
}

/** Read and parse the obligations file at `path` in `commit`'s tree, or undefined if there is none. */
async function readObligations(
  backend: Backend,
  commit: Revision,
  path: FilePath,
): Promise<ObligationsFile | undefined> {
  const text = await backend.readFile(commit, path);
  if (text === undefined) {
    return undefined;
  }
  try {
    return parseObligationsFile(text);
  } catch (cause) {
    const detail =
      cause instanceof z.ZodError ? `\n${z.prettifyError(cause)}` : cause instanceof Error ? `: ${cause.message}` : "";
    throw new UserError(`malformed obligations file ${JSON.stringify(path)} at ${commit.slice(0, 12)}${detail}`);
  }
}

/**
 * Whether gitignore-style `pattern` matches `path`, a path relative to the
 * pattern's directory. A pattern without `/` matches the file's name at any
 * depth; one with `/` matches the whole relative path, where `*` stops at
 * separators and `**` does not. Dotfiles match like any other file.
 */
export function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  const target = anchored.includes("/") ? path : path.slice(path.lastIndexOf("/") + 1);
  return picomatch(anchored, { dot: true })(target);
}

/** One requirement put on one changed file. */
export interface Obligation {
  readonly file: FilePath;
  /** The obligations file that put the requirement there, or the implicit standing that did: the owner's self-review, or a reviewer's whole-diff review. */
  readonly source: FilePath | "owner" | "reviewer";
  readonly require: Requirement;
}

/**
 * The obligations the tip tree puts on `files`: for each file, the matching
 * rules of every obligations file from its own directory up to the repository
 * root, stopping at one marked `root`. A changed obligations file additionally
 * carries every requirement its base version states, whether or not the old
 * rules match it — the policy being replaced signs off on its replacement.
 */
export async function changeObligations(
  backend: Backend,
  base: Revision,
  tip: Revision,
  files: readonly FilePath[],
): Promise<readonly Obligation[]> {
  const cache = new Map<FilePath, Promise<ObligationsFile | undefined>>();
  const load = (path: FilePath): Promise<ObligationsFile | undefined> => {
    let loading = cache.get(path);
    if (loading === undefined) {
      loading = readObligations(backend, tip, path);
      cache.set(path, loading);
    }
    return loading;
  };
  const obligations: Obligation[] = [];
  for (const file of files) {
    const parts = file.split("/");
    for (let depth = parts.length - 1; depth >= 0; depth--) {
      const source = parseFilePath([...parts.slice(0, depth), OBLIGATIONS_FILE].join("/"));
      const policy = await load(source);
      if (policy === undefined) {
        continue;
      }
      const relative = parts.slice(depth).join("/");
      for (const rule of policy.rules) {
        if (patternMatches(rule.match, relative)) {
          obligations.push({ file, source, require: rule.require });
        }
      }
      if (policy.root) {
        break;
      }
    }
    if (parts.at(-1) === OBLIGATIONS_FILE) {
      const replaced = await readObligations(backend, base, file);
      for (const rule of replaced?.rules ?? []) {
        obligations.push({ file, source: file, require: rule.require });
      }
    }
  }
  return obligations;
}

/**
 * Whether any of `self`'s identities is currently asked to review `change`.
 * The reviewing set gates what todos ask of people and nudges review recorded
 * ahead of its turn, never what landing requires: an obligation only someone
 * outside the set can satisfy still blocks the land, which is what forces
 * widening.
 */
export function isReviewing(self: Self, change: ChangeName, entries: readonly LogEntry[]): boolean {
  switch (currentReviewing(entries)) {
    case "none":
      return false;
    case "owner":
      return isSelf(self, currentOwner(change, entries));
    case "reviewers":
      return (
        isSelf(self, currentOwner(change, entries)) ||
        currentReviewers(entries).some((reviewer) => isSelf(self, reviewer))
      );
    case "everyone":
      return true;
  }
}

/**
 * The reviewing check failed: `change`'s reviewing set does not include the
 * user. The message states only the fact; each frontend attaches its own
 * override remedy — a flag, a confirmation dialog — before showing it.
 */
export class NotReviewingError extends UserError {
  constructor(
    readonly change: ChangeName,
    readonly reviewing: Reviewing,
    readonly user: UserName,
  ) {
    super(`${JSON.stringify(change)} is reviewing ${reviewing}, not ${JSON.stringify(user)}`);
  }
}

/**
 * Whether `self` may record review of `change` without a nudge: the
 * reviewing set includes them, they own the change — self-review is welcome
 * at any stage, including a draft's, and widening skips an owner who already
 * read the whole diff — or the change has landed, where review is
 * bookkeeping, open to anyone as ever.
 */
export function mayRecordReview(self: Self, change: ChangeName, entries: readonly LogEntry[]): boolean {
  return (
    landedMerge(entries) !== undefined ||
    isReviewing(self, change, entries) ||
    isSelf(self, currentOwner(change, entries))
  );
}

/**
 * Fail with `NotReviewingError` unless the current user may record review of
 * `change` (as `mayRecordReview`). Recording ahead of one's turn is usually
 * a mistake (the diff is still being rewritten), but a review is a true
 * statement however early, so the check nudges rather than forbids:
 * frontends offer an override, and an overridden review counts toward
 * obligations like any other.
 */
export async function assertReviewing(
  backend: Backend,
  change: ChangeName,
  entries: readonly LogEntry[],
): Promise<void> {
  const self = await currentSelf(backend);
  if (!mayRecordReview(self, change, entries)) {
    throw new NotReviewingError(change, currentReviewing(entries), self.user);
  }
}

/** An obligation and the reviews counting toward it. */
export interface ObligationStatus {
  readonly obligation: Obligation;
  /** The users of the requirement whose review covers the file, sorted by name. */
  readonly reviewedBy: readonly UserName[];
}

/** Whether enough of the requirement's users have reviewed. */
export function isSatisfied({ obligation, reviewedBy }: ObligationStatus): boolean {
  return reviewedBy.length >= obligation.require.atLeast;
}

/**
 * The status of every obligation on `diff`, owned by `owner`. Only files
 * changed within the change's own review spans are governed: the diff a
 * land merge brings in was reviewed in the landed child, under the child's
 * own obligations. Independent of any rules, every governed file carries the
 * owner's implicit self-review requirement, and one likewise for each of the
 * change's reviewers. A user counts toward a requirement exactly when no
 * round of review is left for them on the file.
 */
export async function obligationStatuses(
  backend: Backend,
  entries: readonly LogEntry[],
  owner: UserName,
  diff: ChangeDiff,
): Promise<readonly ObligationStatus[]> {
  const sorted = [...diff.changed.keys()].sort();
  // An owning reviewer already owes every file as owner; a second identical
  // requirement would only double the noise.
  const standings: readonly (readonly [UserName, "owner" | "reviewer"])[] = [
    [owner, "owner"],
    ...currentReviewers(entries)
      .filter((reviewer) => reviewer !== owner)
      .map((reviewer) => [reviewer, "reviewer"] as const),
  ];
  const obligations: Obligation[] = [
    ...standings.flatMap(([user, source]) =>
      sorted.map((file) => ({ file, source, require: { atLeast: 1, of: [user] } })),
    ),
    ...(await changeObligations(backend, diff.base, diff.tip, sorted)),
  ];
  const left = new Map<UserName, ReadonlySet<FilePath>>();
  for (const user of new Set(obligations.flatMap(({ require }) => require.of))) {
    const round = await reviewRound(backend, entries, user, diff);
    left.set(user, new Set(round?.files.keys() ?? []));
  }
  const covered = (user: UserName, file: FilePath): boolean => {
    const due = left.get(user);
    if (due === undefined) {
      throw new Error(`review state not computed for ${JSON.stringify(user)}`);
    }
    return !due.has(file);
  };
  return obligations.map((obligation) => ({
    obligation,
    reviewedBy: obligation.require.of.filter((user) => covered(user, obligation.file)).sort(),
  }));
}

/** The users who can still count toward the requirement. */
function outstanding({ obligation, reviewedBy }: ObligationStatus): readonly UserName[] {
  return obligation.require.of.filter((user) => !reviewedBy.includes(user));
}

/**
 * The files of `diff` with an unsatisfied obligation that a review from
 * `self` — any of their identities — can still count toward, sorted by name.
 * Empty exactly when the change needs nothing from them — however much of it
 * they have not read.
 */
export async function reviewOwed(
  backend: Backend,
  entries: readonly LogEntry[],
  owner: UserName,
  self: Self,
  diff: ChangeDiff,
): Promise<readonly FilePath[]> {
  const statuses = await obligationStatuses(backend, entries, owner, diff);
  const owed = statuses.filter(
    (status) => !isSatisfied(status) && outstanding(status).some((user) => isSelf(self, user)),
  );
  return [...new Set(owed.map(({ obligation }) => obligation.file))].sort();
}

/** One line per unsatisfied obligation: the file, the reviews missing, and the rule's source. */
function obligationDetails(unsatisfied: readonly ObligationStatus[]): readonly string[] {
  return unsatisfied.map((status) => {
    const { file, source, require } = status.obligation;
    const missing = require.atLeast - status.reviewedBy.length;
    return `  ${file}: ${missing} more of ${outstanding(status).join(", ")} (${source})`;
  });
}

/**
 * Review obligations block the land. Each detail line names one unsatisfied
 * requirement: how many reviews are missing and who can still provide them.
 * The message states only the facts; each frontend attaches its own override
 * remedy — a flag, a confirmation dialog — before showing it.
 */
export class UnsatisfiedObligationsError extends UserError {
  /** One line per unsatisfied obligation, as `obligationDetails`. */
  readonly details: readonly string[];

  constructor(readonly unsatisfied: readonly ObligationStatus[]) {
    const details = obligationDetails(unsatisfied);
    super(`review obligations are unsatisfied:\n${details.join("\n")}`);
    this.details = details;
  }
}

/**
 * The parent's review obligations block the land: a land absorbs the child
 * into the parent's diff and advances what its reviewers are asked to hold,
 * so the parent settles its own pending review first. The message states
 * only the facts; each frontend attaches its own override remedy.
 */
export class UnreviewedParentError extends UserError {
  /** One line per unsatisfied obligation, as `obligationDetails`. */
  readonly details: readonly string[];

  constructor(
    readonly parent: ChangeName,
    readonly unsatisfied: readonly ObligationStatus[],
  ) {
    const details = obligationDetails(unsatisfied);
    super(`parent ${JSON.stringify(parent)} has unsatisfied review obligations:\n${details.join("\n")}`);
    this.details = details;
  }
}

/** One reviewer's tally of unsatisfied obligations: how many files await them. */
export interface ReviewerTally {
  readonly user: UserName;
  readonly files: number;
}

/**
 * One tally per user whose review could satisfy some of `unsatisfied`, sorted
 * by name: how many files await them. A per-reviewer digest of the per-file
 * `details`, for surfaces too small to show every obligation. Deliberately
 * vague about who must act: a requirement satisfiable by any of several users
 * tallies the file under each of them.
 */
export function reviewerTallies(unsatisfied: readonly ObligationStatus[]): readonly ReviewerTally[] {
  const due = new Map<UserName, Set<FilePath>>();
  for (const status of unsatisfied) {
    for (const user of outstanding(status)) {
      let files = due.get(user);
      if (files === undefined) {
        files = new Set();
        due.set(user, files);
      }
      files.add(status.obligation.file);
    }
  }
  return [...due]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([user, files]) => ({ user, files: files.size }));
}

/** A tally as prose: `bob@example.com: 2 files`. */
export function tallyText({ user, files }: ReviewerTally): string {
  return `${user}: ${files} ${files === 1 ? "file" : "files"}`;
}

/** The tallies of `unsatisfied` as prose lines, as `reviewerTallies` orders them. */
export function reviewerSummary(unsatisfied: readonly ObligationStatus[]): readonly string[] {
  return reviewerTallies(unsatisfied).map(tallyText);
}

/** Fail with `UnsatisfiedObligationsError` unless every obligation on `diff` is satisfied. */
export async function assertObligationsSatisfied(
  backend: Backend,
  entries: readonly LogEntry[],
  owner: UserName,
  diff: ChangeDiff,
): Promise<void> {
  const statuses = await obligationStatuses(backend, entries, owner, diff);
  const unsatisfied = statuses.filter((status) => !isSatisfied(status));
  if (unsatisfied.length > 0) {
    throw new UnsatisfiedObligationsError(unsatisfied);
  }
}

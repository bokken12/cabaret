import picomatch from "picomatch/posix.js";
import { z } from "zod";
import {
  type Backend,
  type CommitHash,
  type FilePath,
  type LogEntry,
  parseFilePath,
  reviewSegments,
  type UserName,
  userName,
} from "./backend.js";
import { UserError } from "./error.js";
import { reviewRounds } from "./summary.js";

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
  commit: CommitHash,
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
function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  const target = anchored.includes("/") ? path : path.slice(path.lastIndexOf("/") + 1);
  return picomatch(anchored, { dot: true })(target);
}

/** One requirement put on one changed file, and the obligations file that put it there. */
export interface Obligation {
  readonly file: FilePath;
  readonly source: FilePath;
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
  base: CommitHash,
  tip: CommitHash,
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
 * The status of every obligation on `base`..`tip`. Only files changed within
 * the change's own review spans are governed: the diff a land merge brings in
 * was reviewed in the landed child, under the child's own obligations. A user
 * counts toward a requirement exactly when no round of review is left for
 * them on the file.
 */
export async function obligationStatuses(
  backend: Backend,
  entries: readonly LogEntry[],
  base: CommitHash,
  tip: CommitHash,
): Promise<readonly ObligationStatus[]> {
  const files = new Set<FilePath>();
  for (const { start, end } of await reviewSegments(backend, base, tip)) {
    for (const file of await backend.changedFiles(start, end)) {
      files.add(file);
    }
  }
  const obligations = await changeObligations(backend, base, tip, [...files].sort());
  const left = new Map<UserName, ReadonlySet<FilePath>>();
  for (const user of new Set(obligations.flatMap(({ require }) => require.of))) {
    const rounds = await reviewRounds(backend, entries, user, base, tip);
    left.set(user, new Set(rounds.flatMap(({ files: due }) => [...due.keys()])));
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

/**
 * Fail unless every obligation on `base`..`tip` is satisfied, naming per
 * requirement how many reviews are missing and who can still provide them.
 */
export async function assertObligationsSatisfied(
  backend: Backend,
  entries: readonly LogEntry[],
  base: CommitHash,
  tip: CommitHash,
): Promise<void> {
  const unsatisfied = (await obligationStatuses(backend, entries, base, tip)).filter((status) => !isSatisfied(status));
  if (unsatisfied.length === 0) {
    return;
  }
  const lines = unsatisfied.map(({ obligation: { file, source, require }, reviewedBy }) => {
    const missing = require.atLeast - reviewedBy.length;
    const candidates = require.of.filter((user) => !reviewedBy.includes(user));
    return `  ${file}: ${missing} more of ${candidates.join(", ")} (${source})`;
  });
  throw new UserError(`review obligations are unsatisfied:\n${lines.join("\n")}`);
}

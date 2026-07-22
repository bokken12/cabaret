import {
  assertChangeExists,
  type Backend,
  type ChangeName,
  defaultContext,
  type FilePath,
  type LogEntry,
  parseContext,
  patternMatches,
  UserError,
  type UserName,
  userName,
} from "cabaret-core";
import { type Doc, docText } from "cabaret-views";
import type { LocalContext } from "../context.js";

/**
 * The `--change` flag of a command that acts on one change: "Change to <act>
 * (defaults to current)". Carried as a raw string — only the backend knows
 * its name grammar — and validated by `resolveChange` or `parseName`.
 */
export function changeFlag(act: string) {
  return {
    kind: "parsed",
    parse: String,
    brief: `Change to ${act} (defaults to current)`,
    optional: true,
  } as const;
}

/**
 * The change a command acts on — `flagged`, parsed by the backend's name
 * grammar, or the current change — with its log. The change must exist: logs
 * are only ever started by `create`, so acting on a missing one would conjure
 * a change out of thin air.
 */
export async function resolveChange(
  backend: Backend,
  flagged: string | undefined,
): Promise<{ change: ChangeName; entries: readonly LogEntry[] }> {
  const change = flagged === undefined ? await backend.currentChange() : backend.parseName(flagged);
  const entries = await backend.readLog(change);
  assertChangeExists(change, entries);
  return { change, entries };
}

/** Parse a user argument, rejecting the empty string. */
export function parseUser(raw: string): UserName {
  if (raw === "") {
    throw new UserError("user must be nonempty");
  }
  return userName(raw);
}

/**
 * What a rebase or land applies to: one change, or an `ancestor..descendant`
 * range of them. As with git's `upstream..branch`, the left endpoint is
 * excluded: it bounds the range and is never itself operated on. Names ride
 * raw until a backend's grammar parses them.
 */
export type ChangeSpec =
  | { readonly kind: "one"; readonly change: string }
  | { readonly kind: "range"; readonly ancestor: string; readonly descendant: string };

export function parseChangeSpec(raw: string): ChangeSpec {
  const parts = raw.split("..");
  if (parts.length === 1) {
    return { kind: "one", change: raw };
  }
  const [ancestor, descendant] = parts;
  // "a...b" splits into "a" and ".b": the stray leading dot, like an empty
  // endpoint or a second "..", marks a malformed range.
  if (parts.length !== 2 || !ancestor || !descendant || descendant.startsWith(".")) {
    throw new UserError(`not a change or ancestor..descendant range: ${JSON.stringify(raw)}`);
  }
  return { kind: "range", ancestor, descendant };
}

/**
 * The `--context` flag of a command that renders diffs.
 */
export const contextFlag = {
  kind: "parsed",
  parse: parseContext,
  brief: `Lines of context around each hunk, -1 for whole files (defaults to the cabaret.context setting, or ${defaultContext})`,
  optional: true,
} as const;

/**
 * The files among `candidates` — described by `what` in diagnostics — that
 * `args` select, in `candidates`' order. No arguments select everything. An
 * argument with a glob character is a gitignore-style pattern against
 * repo-relative paths, and matching nothing is a mistake worth stopping on —
 * a typo would otherwise silently select nothing. Any other argument is a path,
 * resolved the way every command resolves one; one naming a file outside
 * `candidates` is an error under `strict` (marking it would record nothing)
 * and otherwise appends the file, for a viewer to answer "nothing here"
 * about.
 */
export function selectFiles(
  backend: Backend,
  candidates: readonly FilePath[],
  args: readonly string[],
  strict: boolean,
  what: string,
): readonly FilePath[] {
  if (args.length === 0) {
    return candidates;
  }
  const selected = new Set<FilePath>();
  const appended: FilePath[] = [];
  for (const raw of args) {
    if (/[*?[]/.test(raw)) {
      const matches = candidates.filter((file) => patternMatches(raw, file));
      if (matches.length === 0) {
        throw new UserError(`no ${what} matches ${JSON.stringify(raw)}`);
      }
      for (const file of matches) {
        selected.add(file);
      }
    } else {
      const file = backend.resolveFile(raw);
      if (candidates.includes(file)) {
        selected.add(file);
      } else if (strict) {
        throw new UserError(`no review left in ${file}`);
      } else if (!appended.includes(file)) {
        appended.push(file);
      }
    }
  }
  return [...candidates.filter((file) => selected.has(file)), ...appended];
}

/** The escape hatch for commands that `requireOwner` guards. */
export const evenThoughNotOwner = {
  kind: "boolean",
  brief: "Proceed even though you do not own the change",
  default: false,
} as const;

/** Print a rendered page: its text to stdout, its errors to stderr. */
export function writeDoc(context: LocalContext, doc: Doc): void {
  context.process.stdout.write(`${docText(doc)}\n`);
  for (const error of doc.errors) {
    context.process.stderr.write(`${error}\n`);
  }
}

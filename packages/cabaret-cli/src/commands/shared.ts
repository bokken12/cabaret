import {
  assertChangeExists,
  type Backend,
  type ChangeName,
  defaultContext,
  type FilePath,
  type Forge,
  type LogEntry,
  parseContext,
  patternMatches,
  type ReconcileResult,
  reconcileChange,
  UserError,
  type UserName,
  userName,
} from "cabaret-core";
import { NoForgeError } from "cabaret-node";
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

/** The forge fronting origin, or undefined when origin has none. */
export async function forgeIfAny(context: LocalContext): Promise<Forge | undefined> {
  try {
    return await context.forge();
  } catch (error) {
    if (!(error instanceof NoForgeError)) {
      throw error;
    }
    return undefined;
  }
}

/** What a reconcile settled, one line per movement, in the CLI's voice. */
export function settledLines(locator: string | undefined, result: ReconcileResult): string[] {
  const lines: string[] = [];
  const s = (n: number): string => (n === 1 ? "" : "s");
  const { absorbed, published } = result;
  if (published === undefined) {
    return lines;
  }
  const name = `${locator}#${published.id}`;
  if (absorbed !== undefined) {
    if (absorbed.landed) {
      lines.push(`${name} was merged; recorded the land`);
    }
    if (absorbed.parent !== undefined) {
      lines.push(`${name} was retargeted; reparented onto ${JSON.stringify(absorbed.parent)}`);
    }
    if (absorbed.reviewers > 0) {
      lines.push(`updated ${absorbed.reviewers} reviewer${s(absorbed.reviewers)} from ${name}`);
    }
    if (absorbed.reviewing !== undefined) {
      lines.push(
        `${name} was marked ${absorbed.reviewing === "none" ? "draft" : "ready"}; reviewing ${absorbed.reviewing}`,
      );
    }
    if (absorbed.archived !== undefined) {
      lines.push(
        `${name} was ${absorbed.archived ? "closed; archived the change" : "reopened; unarchived the change"}`,
      );
    }
    if (absorbed.comments > 0) {
      lines.push(`fetched ${absorbed.comments} comment${s(absorbed.comments)} from ${name}`);
    }
  }
  if (published.opened) {
    lines.push(`opened ${name}`);
  }
  if (published.reviewers > 0) {
    lines.push(`updated ${published.reviewers} reviewer${s(published.reviewers)} on ${name}`);
  }
  if (published.draft !== undefined) {
    lines.push(`marked ${name} ${published.draft ? "draft" : "ready for review"}`);
  }
  if (published.state !== undefined) {
    lines.push(`${published.state === "closed" ? "closed" : "reopened"} ${name}`);
  }
  if (published.archived !== undefined) {
    lines.push(`${name} was ${published.archived ? "closed; archived the change" : "reopened; unarchived the change"}`);
  }
  if (published.comments > 0) {
    lines.push(`posted ${published.comments} comment${s(published.comments)} to ${name}`);
  }
  return lines;
}

/**
 * Push `change`'s log and settle its forge change, as every command that
 * appends to a log does on its way out: the append was the publication
 * intent, so carrying it asks no further consent.
 */
export async function writeThrough(context: LocalContext, backend: Backend, change: ChangeName): Promise<void> {
  const forge = await forgeIfAny(context);
  const result = await reconcileChange(backend, context.now, forge, change);
  if (result.offline) {
    context.process.stdout.write("origin unreachable; sync to publish\n");
    return;
  }
  for (const line of settledLines(forge?.locator, result)) {
    context.process.stdout.write(`${line}\n`);
  }
}

import {
  assertChangeExists,
  type Backend,
  type ChangeName,
  type LogEntry,
  type Revision,
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
export async function resolveChange<R extends Revision, C extends ChangeName>(
  backend: Backend<R, C>,
  flagged: string | undefined,
): Promise<{ change: C; entries: readonly LogEntry<R, C>[] }> {
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

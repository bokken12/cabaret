import { z } from "zod";
import {
  type Backend,
  type ChangeId,
  type ChangeName,
  currentArchived,
  currentName,
  type LogEntry,
} from "./backend.js";
import { UserError } from "./error.js";

/**
 * A change in hand: its identity and its log, as read at resolution time.
 * The id is the one fact not derivable from the log — everything else
 * (name, owner, parent, …) is a fold over `entries`, computed where it is
 * used so it can never disagree with the log it came from.
 */
export interface Change {
  readonly id: ChangeId;
  readonly entries: readonly LogEntry[];
}

/**
 * Every change, each with its log read once — the read behind every
 * whole-repo view. Sorted by name (ids break ties), so iteration order is
 * deterministic and identical on every machine; ids are random, so their
 * order means nothing. Resolving one name does not need this: `resolveChange`
 * reads through the name index instead.
 */
export async function allChanges(backend: Backend): Promise<readonly Change[]> {
  const changes: Change[] = [];
  for (const id of await backend.listChanges()) {
    changes.push({ id, entries: await backend.readLog(id) });
  }
  return changes
    .map((change) => ({ change, name: currentName(change.id, change.entries) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.change.id < b.change.id ? -1 : 1))
    .map(({ change }) => change);
}

/** When the change last moved: its latest entry's timestamp. */
function lastActivity(entries: readonly LogEntry[]): number {
  return entries.reduce((latest, entry) => Math.max(latest, entry.timestamp), 0);
}

/** The resolution facts of one change: what arbitration reads, however they were derived. */
interface NameFacts {
  readonly id: ChangeId;
  readonly name: ChangeName;
  readonly archived: boolean;
  readonly activity: number;
}

function factsOf(change: Change): NameFacts {
  return {
    id: change.id,
    name: currentName(change.id, change.entries),
    archived: currentArchived(change.entries),
    activity: lastActivity(change.entries),
  };
}

/**
 * The claimant `name` resolves to among `facts`, or undefined when none
 * claims it. Names are unique among live changes by convention, not
 * invariant, so resolution arbitrates: live claims beat archived ones,
 * archived claims resolve by most recent activity, and a genuine tie among
 * live claims is an error naming the contenders' ids.
 *
 * TODO: fetch should nudge the later claimant of a live collision; until
 * the rename command exists, the ambiguity error is the only surface.
 */
function arbitrate(facts: readonly NameFacts[], name: ChangeName): NameFacts | undefined {
  const claims = facts.filter((fact) => fact.name === name);
  if (claims.length <= 1) {
    return claims[0];
  }
  const live = claims.filter((fact) => !fact.archived);
  if (live.length > 1) {
    const ids = live.map(({ id }) => id).sort();
    throw new UserError(`multiple live changes are named ${JSON.stringify(name)}: ${ids.join(", ")}; use an id`);
  }
  const [only] = live;
  if (only !== undefined) {
    return only;
  }
  return claims.reduce((latest, claim) => (claim.activity > latest.activity ? claim : latest));
}

/** The unique id of `ids` that `prefix` abbreviates, or undefined; several matches are an error naming them. */
function matchIdPrefix(ids: readonly ChangeId[], prefix: string): ChangeId | undefined {
  if (!/^[0-9a-f]{4,32}$/.test(prefix)) {
    return undefined;
  }
  const matches = ids.filter((id) => id.startsWith(prefix)).sort();
  if (matches.length > 1) {
    throw new UserError(`ambiguous id prefix ${JSON.stringify(prefix)}: ${matches.join(", ")}`);
  }
  return matches[0];
}

/** The change `name` resolves to among `changes`, or undefined when no change claims it. */
export function resolveNamed(changes: readonly Change[], name: ChangeName): Change | undefined {
  const winner = arbitrate(changes.map(factsOf), name);
  return winner === undefined ? undefined : changes.find((change) => change.id === winner.id);
}

/**
 * As `resolveNamed`, but failing when no change claims `name` — after
 * trying `name` as an id prefix, which is how the ambiguity error's "use an
 * id" advice resolves. Names win: prefixes only match when no change wears
 * the name.
 */
export function requireNamed(changes: readonly Change[], name: ChangeName): Change {
  const found = resolveNamed(changes, name);
  if (found !== undefined) {
    return found;
  }
  const matched = matchIdPrefix(
    changes.map(({ id }) => id),
    name,
  );
  const change = changes.find(({ id }) => id === matched);
  if (change !== undefined) {
    return change;
  }
  throw new UserError(
    `change does not exist: ${JSON.stringify(name)}; run \`cab create\`, or \`cab fetch\` to import open forge changes`,
  );
}

/**
 * The name index: every change's resolution facts, each pinned to the log
 * state it was folded from. Resolving a name verifies against `logStates` —
 * one cheap read, no log contents — and re-folds only logs that moved, so a
 * warm resolution reads nothing but its winner. Derivable state, local to
 * this repository, never replicated.
 */
interface IndexedChange extends NameFacts {
  /** The log position the facts were folded at, as `logStates` reports it. */
  readonly state: string;
}

const IndexSchema = z.array(
  z.object({
    id: z.string().transform((raw) => raw as ChangeId),
    name: z
      .string()
      .min(1)
      .transform((raw) => raw as ChangeName),
    archived: z.boolean(),
    activity: z.number(),
    state: z.string().min(1),
  }),
) satisfies z.ZodType<IndexedChange[]>;

const INDEX_KEY = "names.json";

/** Read the verified index: held facts where the log has not moved, fresh folds where it has. */
async function indexedChanges(backend: Backend): Promise<readonly IndexedChange[]> {
  const states = await backend.logStates();
  const held = new Map<ChangeId, IndexedChange>();
  try {
    const raw = await backend.readCache(INDEX_KEY);
    if (raw !== undefined) {
      for (const entry of IndexSchema.parse(JSON.parse(raw))) {
        held.set(entry.id, entry);
      }
    }
  } catch {
    // An unreadable index is no index: every fact re-folds below.
  }
  const fresh: IndexedChange[] = [];
  let drifted = held.size !== states.size;
  for (const [id, state] of states) {
    const have = held.get(id);
    if (have !== undefined && have.state === state) {
      fresh.push(have);
      continue;
    }
    drifted = true;
    fresh.push({ ...factsOf({ id, entries: await backend.readLog(id) }), state });
  }
  if (drifted) {
    await backend.writeCache(INDEX_KEY, JSON.stringify(fresh));
  }
  return fresh;
}

/**
 * The change `name` resolves to, read through the name index, or undefined
 * when no change claims it: arbitration runs on indexed facts and only the
 * winner's log is read.
 */
export async function lookupChange(backend: Backend, name: ChangeName): Promise<Change | undefined> {
  const winner = arbitrate(await indexedChanges(backend), name);
  return winner === undefined ? undefined : { id: winner.id, entries: await backend.readLog(winner.id) };
}

/** Resolve `name` to its change through the name index, failing — after trying `name` as an id prefix — when no change claims it. */
export async function resolveChange(backend: Backend, name: ChangeName): Promise<Change> {
  const index = await indexedChanges(backend);
  const winner = arbitrate(index, name) ?? {
    id: matchIdPrefix(
      index.map(({ id }) => id),
      name,
    ),
  };
  if (winner.id !== undefined) {
    return { id: winner.id, entries: await backend.readLog(winner.id) };
  }
  throw new UserError(
    `change does not exist: ${JSON.stringify(name)}; run \`cab create\`, or \`cab fetch\` to import open forge changes`,
  );
}

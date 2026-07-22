import { z } from "zod";
import {
  type Backend,
  type Change,
  type ChangeId,
  type ChangeName,
  currentArchived,
  currentName,
  type LogEntry,
  type ParentRef,
} from "./backend.js";
import { UserError } from "./error.js";

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
 * live claims is an error naming the contenders' ids — `nameCollisions` is
 * how fetch nudges before anyone hits it.
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
 * The name index: each change's name pinned to the log state it was folded
 * from — the mapping resolution needs, and nothing folded beyond it.
 * Resolving a name verifies against `logStates` — one cheap read, no log
 * contents — re-folds only logs that moved, and then reads just the
 * claimants (almost always one: the winner). Derivable state, local to this
 * repository, never replicated.
 */
interface IndexedName {
  readonly id: ChangeId;
  readonly name: ChangeName;
  /** The log position the name was folded at, as `logStates` reports it. */
  readonly state: string;
}

const IndexSchema = z.array(
  z.object({
    id: z.string().transform((raw) => raw as ChangeId),
    name: z
      .string()
      .min(1)
      .transform((raw) => raw as ChangeName),
    state: z.string().min(1),
  }),
) satisfies z.ZodType<IndexedName[]>;

const INDEX_KEY = "names.json";

/** Read the verified index: held names where the log has not moved, fresh folds where it has. */
async function indexedNames(backend: Backend): Promise<readonly IndexedName[]> {
  const states = await backend.logStates();
  const held = new Map<ChangeId, IndexedName>();
  try {
    const raw = await backend.readCache(INDEX_KEY);
    if (raw !== undefined) {
      for (const entry of IndexSchema.parse(JSON.parse(raw))) {
        held.set(entry.id, entry);
      }
    }
  } catch {
    // An unreadable index is no index: every name re-folds below.
  }
  const fresh: IndexedName[] = [];
  let drifted = held.size !== states.size;
  for (const [id, state] of states) {
    const have = held.get(id);
    if (have !== undefined && have.state === state) {
      fresh.push(have);
      continue;
    }
    drifted = true;
    fresh.push({ id, name: currentName(id, await backend.readLog(id)), state });
  }
  if (drifted) {
    await backend.writeCache(INDEX_KEY, JSON.stringify(fresh));
  }
  return fresh;
}

/**
 * The change `name` resolves to, read through the name index, or undefined
 * when no change claims it. Only the claimants' logs are read — almost
 * always one — and arbitration folds their fresh entries, so a claim that
 * moved since indexing counts as what it is now.
 */
export async function lookupChange(backend: Backend, name: ChangeName): Promise<Change | undefined> {
  const index = await indexedNames(backend);
  const claims: Change[] = await Promise.all(
    index.filter((entry) => entry.name === name).map(async ({ id }) => ({ id, entries: await backend.readLog(id) })),
  );
  return resolveNamed(claims, name);
}

/** The change an id prefix abbreviates, read through the name index, or undefined when it matches none. */
export async function changeByIdPrefix(backend: Backend, prefix: string): Promise<Change | undefined> {
  const matched = matchIdPrefix(
    (await indexedNames(backend)).map(({ id }) => id),
    prefix,
  );
  return matched === undefined ? undefined : { id: matched, entries: await backend.readLog(matched) };
}

/** Resolve `name` to its change through the name index, failing — after trying `name` as an id prefix — when no change claims it. */
export async function resolveChange(backend: Backend, name: ChangeName): Promise<Change> {
  const found = await lookupChange(backend, name);
  if (found !== undefined) {
    return found;
  }
  const abbreviated = await changeByIdPrefix(backend, name);
  if (abbreviated !== undefined) {
    return abbreviated;
  }
  throw new UserError(
    `change does not exist: ${JSON.stringify(name)}; run \`cab create\`, or \`cab fetch\` to import open forge changes`,
  );
}

/**
 * Names more than one live change claims, each with its claimants' ids
 * sorted — what fetch nudges about, since a collision otherwise surfaces
 * only as resolution's ambiguity error. Reads through the index: only names
 * indexed more than once have their claimants' logs read at all.
 */
export async function nameCollisions(
  backend: Backend,
): Promise<readonly { readonly name: ChangeName; readonly ids: readonly ChangeId[] }[]> {
  const byName = new Map<ChangeName, ChangeId[]>();
  for (const entry of await indexedNames(backend)) {
    byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry.id]);
  }
  const collisions: { name: ChangeName; ids: ChangeId[] }[] = [];
  for (const [name, ids] of byName) {
    if (ids.length < 2) {
      continue;
    }
    const live: ChangeId[] = [];
    for (const id of ids) {
      if (!currentArchived(await backend.readLog(id))) {
        live.push(id);
      }
    }
    if (live.length > 1) {
      collisions.push({ name, ids: live.sort() });
    }
  }
  return collisions.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * The change a parent reference points at: a change arm's log read outright,
 * a branch arm resolved by name. Undefined when the parent is a bare branch
 * with no change, or a change whose log this clone does not hold.
 */
export async function resolveParent(backend: Backend, ref: ParentRef): Promise<Change | undefined> {
  if (ref.kind === "change") {
    const entries = await backend.readLog(ref.id);
    return entries.length === 0 ? undefined : { id: ref.id, entries };
  }
  return lookupChange(backend, ref.name);
}

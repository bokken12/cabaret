import {
  type Backend,
  type ChangeId,
  type ChangeName,
  currentArchived,
  currentName,
  type LogEntry,
} from "./backend.js";
import { UserError } from "./error.js";

/** A change resolved by name: its identity, current name, and log. */
export interface NamedChange {
  readonly id: ChangeId;
  readonly name: ChangeName;
  readonly entries: readonly LogEntry[];
}

/**
 * Every change, each with its log read once — the read behind all name
 * resolution and every whole-repo view. Sorted by name (ids break ties), so
 * iteration order is deterministic and identical on every machine; ids are
 * random, so their order means nothing.
 */
export async function allChanges(backend: Backend): Promise<readonly NamedChange[]> {
  const changes: NamedChange[] = [];
  for (const id of await backend.listChanges()) {
    const entries = await backend.readLog(id);
    const name = currentName(entries);
    if (name === undefined) {
      throw new Error(`log has no name: ${id}`);
    }
    changes.push({ id, name, entries });
  }
  return changes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
}

/** When the change last moved: its latest entry's timestamp. */
function lastActivity(entries: readonly LogEntry[]): number {
  return entries.reduce((latest, entry) => Math.max(latest, entry.timestamp), 0);
}

/**
 * The change `name` resolves to, or undefined when no change claims it.
 * Names are unique among live changes by convention, not invariant, so
 * resolution arbitrates: live claims beat archived ones, archived claims
 * resolve by most recent activity, and a genuine tie among live claims is
 * an error naming the contenders' ids.
 */
export function resolveNamed(changes: readonly NamedChange[], name: ChangeName): NamedChange | undefined {
  const claims = changes.filter((change) => change.name === name);
  if (claims.length <= 1) {
    return claims[0];
  }
  const live = claims.filter((change) => !currentArchived(change.entries));
  if (live.length > 1) {
    const ids = live.map(({ id }) => id).sort();
    throw new UserError(`multiple live changes are named ${JSON.stringify(name)}: ${ids.join(", ")}; use an id`);
  }
  const [only] = live;
  if (only !== undefined) {
    return only;
  }
  return claims.reduce((latest, claim) =>
    lastActivity(claim.entries) > lastActivity(latest.entries) ? claim : latest,
  );
}

/** As `resolveNamed`, but failing when no change claims `name`. */
export function requireNamed(changes: readonly NamedChange[], name: ChangeName): NamedChange {
  const found = resolveNamed(changes, name);
  if (found === undefined) {
    throw new UserError(
      `change does not exist: ${JSON.stringify(name)}; run \`cab create\`, or \`cab fetch\` to import open forge changes`,
    );
  }
  return found;
}

/** Resolve `name` to its change, failing when no change claims it. */
export async function resolveChange(backend: Backend, name: ChangeName): Promise<NamedChange> {
  return requireNamed(await allChanges(backend), name);
}

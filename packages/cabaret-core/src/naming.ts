import { type Backend, type ChangeId, type ChangeName, currentArchived, currentName, type LogEntry } from "./backend.js";
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
 * Every change, each with its log read once — the read behind all name
 * resolution and every whole-repo view. Sorted by name (ids break ties), so
 * iteration order is deterministic and identical on every machine; ids are
 * random, so their order means nothing.
 *
 * TODO: this reads every log per call, and commands sweep it more than
 * once; a verify-on-use name index should replace the sweeps before repos
 * grow large.
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

/**
 * The change `name` resolves to, or undefined when no change claims it.
 * Names are unique among live changes by convention, not invariant, so
 * resolution arbitrates: live claims beat archived ones, archived claims
 * resolve by most recent activity, and a genuine tie among live claims is
 * an error naming the contenders' ids.
 *
 * TODO: fetch should nudge the later claimant of a live collision; until
 * the rename command exists, the ambiguity error is the only surface.
 */
export function resolveNamed(changes: readonly Change[], name: ChangeName): Change | undefined {
  const claims = changes.filter((change) => currentName(change.id, change.entries) === name);
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
  if (/^[0-9a-f]{4,32}$/.test(name)) {
    const matches = changes.filter((change) => change.id.startsWith(name));
    if (matches.length === 1 && matches[0] !== undefined) {
      return matches[0];
    }
    if (matches.length > 1) {
      throw new UserError(
        `ambiguous id prefix ${JSON.stringify(name)}: ${matches
          .map(({ id }) => id)
          .sort()
          .join(", ")}`,
      );
    }
  }
  throw new UserError(
    `change does not exist: ${JSON.stringify(name)}; run \`cab create\`, or \`cab fetch\` to import open forge changes`,
  );
}

/** Resolve `name` to its change, failing when no change claims it. */
export async function resolveChange(backend: Backend, name: ChangeName): Promise<Change> {
  return requireNamed(await allChanges(backend), name);
}

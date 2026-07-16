import type { Backend, ConfigScope } from "./backend.js";

/**
 * One setting a backend recommends. As with `Setting`, a recommendation
 * about the person lives in global config; one about the repository, in
 * local config.
 */
export interface Recommendation {
  /** The config key to write. */
  readonly key: string;
  /** The value to write: the key's value when single-valued, one of them when multi-valued. */
  readonly value: string;
  /** Where the value lands. */
  readonly scope: ConfigScope;
  /** Whether the key accumulates values rather than holding one. */
  readonly multi: boolean;
  /** What the setting does, phrased to complete "cabaret recommends …". */
  readonly brief: string;
  /** Whether the recommendation makes sense in this repository; omitted means always. */
  readonly applies?: (backend: Backend) => Promise<boolean>;
}

/** How one recommendation stands in a repository. */
export type Standing =
  | { readonly kind: "applied" }
  | { readonly kind: "unset" }
  | { readonly kind: "differs"; readonly current: string };

export interface SetupAudit {
  readonly rec: Recommendation;
  readonly standing: Standing;
}

async function standing(backend: Backend, rec: Recommendation): Promise<Standing> {
  if (rec.multi) {
    // Other values accumulate alongside ours rather than conflicting with it,
    // so a multi-valued key is either applied or unset, never differing.
    const values = await backend.configAll(rec.key);
    return values.includes(rec.value) ? { kind: "applied" } : { kind: "unset" };
  }
  const current = await backend.config(rec.key);
  if (current === undefined) {
    return { kind: "unset" };
  }
  return current === rec.value ? { kind: "applied" } : { kind: "differs", current };
}

/** Audit the recommendations that apply to `backend`'s repository. */
export async function auditSetup(backend: Backend): Promise<readonly SetupAudit[]> {
  const audits: SetupAudit[] = [];
  for (const rec of backend.setupRecommendations()) {
    if (rec.applies === undefined || (await rec.applies(backend))) {
      audits.push({ rec, standing: await standing(backend, rec) });
    }
  }
  return audits;
}

/**
 * Apply every unset recommendation in `audits`. A key set to another value is
 * the person's choice and stays untouched.
 */
export async function applySetup(backend: Backend, audits: readonly SetupAudit[]): Promise<void> {
  for (const audit of audits) {
    if (audit.standing.kind !== "unset") {
      continue;
    }
    const { key, value, scope, multi } = audit.rec;
    await (multi ? backend.configAdd(key, value, scope) : backend.configSet(key, value, scope));
  }
}

/**
 * Where a declined setup offer is recorded, at the scope that was declined:
 * global for the person's recommendations, local for the repository's. An
 * accepted offer needs no record — the applied keys themselves are it.
 */
const DECLINED_KEY = "cabaret.setupDeclined";

/** The scopes whose recommendations were offered and declined. */
export async function declinedScopes(backend: Backend): Promise<ReadonlySet<ConfigScope>> {
  const scopes = new Set<ConfigScope>();
  for (const scope of ["global", "local"] as const) {
    if ((await backend.configAll(DECLINED_KEY, scope)).length > 0) {
      scopes.add(scope);
    }
  }
  return scopes;
}

/** Record a declined offer for each of `scopes`, keeping later offers quiet there. */
export async function declineSetup(backend: Backend, scopes: readonly ConfigScope[]): Promise<void> {
  for (const scope of scopes) {
    await backend.configSet(DECLINED_KEY, "true", scope);
  }
}

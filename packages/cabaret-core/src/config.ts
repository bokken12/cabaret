import type { Backend } from "./backend.js";
import { UserError } from "./error.js";

/** How a land writes a change onto its parent: a land merge, or one squash commit. */
export type LandMethod = "merge" | "squash";

/**
 * Where a land executes: in this repository, by merging the change's request
 * on the forge, or ("auto") on the forge exactly when the change's log
 * records a request.
 */
export type LandVia = "local" | "forge" | "auto";

/** How a side-by-side diff fits long lines to its panes, as patdiff. */
export type SideBySide = "wrap" | "truncate";

/** Repository settings, read from `cabaret.*` git config keys. */
export interface Config {
  readonly landMethod: LandMethod;
  readonly landVia: LandVia;
  /** Lines of diff context, -1 for whole files; undefined when unset. */
  readonly context: number | undefined;
  /** Render diffs side by side; undefined for unified diffs. */
  readonly sideBySide: SideBySide | undefined;
}

/** Parse a count of diff context lines from `source`: a nonnegative integer, or -1 for whole files. */
export function parseContext(raw: string, source = "context"): number {
  const context = Number(raw);
  if (!Number.isInteger(context) || context < -1) {
    throw new UserError(`${source} must be a nonnegative integer or -1: ${JSON.stringify(raw)}`);
  }
  return context;
}

function checkChoice<T extends string>(key: string, raw: string, choices: readonly T[]): T {
  if (!(choices as readonly string[]).includes(raw)) {
    throw new UserError(`git config ${key} must be one of ${choices.join(", ")}: ${JSON.stringify(raw)}`);
  }
  return raw as T;
}

function parseChoice<T extends string>(key: string, raw: string | undefined, fallback: T, choices: readonly T[]): T {
  return raw === undefined ? fallback : checkChoice(key, raw, choices);
}

/** Read this repository's Cabaret settings. */
export async function readConfig(backend: Backend): Promise<Config> {
  const [method, via, context, sideBySide] = await Promise.all([
    backend.config("cabaret.landMethod"),
    backend.config("cabaret.landVia"),
    backend.config("cabaret.context"),
    backend.config("cabaret.sideBySide"),
  ]);
  return {
    landMethod: parseChoice("cabaret.landMethod", method, "merge", ["merge", "squash"]),
    landVia: parseChoice("cabaret.landVia", via, "auto", ["local", "forge", "auto"]),
    context: context === undefined ? undefined : parseContext(context, "git config cabaret.context"),
    sideBySide:
      sideBySide === undefined
        ? undefined
        : checkChoice<SideBySide>("cabaret.sideBySide", sideBySide, ["wrap", "truncate"]),
  };
}

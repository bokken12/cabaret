import type { Backend, ConfigScope } from "./backend.js";
import { defaultContext } from "./diff.js";
import { UserError } from "./error.js";

const landMethods = ["merge", "squash"] as const;
const landVias = ["local", "forge", "auto"] as const;
const workspaceStyles = ["shared", "dedicated"] as const;

/** How a land writes a change onto its parent: a land merge, or one squash commit. */
export type LandMethod = (typeof landMethods)[number];

/**
 * Where a land executes: in this repository, by merging the change on the
 * forge, or ("auto") on the forge exactly when the change's log records a
 * forge change.
 */
export type LandVia = (typeof landVias)[number];

/**
 * How going to a change that has no workspace materializes one: check it
 * out in the current workspace, or create a dedicated workspace for it.
 */
export type WorkspaceStyle = (typeof workspaceStyles)[number];

/** Settings read from `cabaret.*` config keys. */
export interface Config {
  readonly landMethod: LandMethod;
  readonly landVia: LandVia;
  /** Lines of diff context, -1 for whole files; undefined when unset. */
  readonly context: number | undefined;
  readonly workspaceStyle: WorkspaceStyle;
}

/** Parse a count of diff context lines from `source`: a nonnegative integer, or -1 for whole files. */
export function parseContext(raw: string, source = "context"): number {
  const context = Number(raw);
  if (!Number.isInteger(context) || context < -1) {
    throw new UserError(`${source} must be a nonnegative integer or -1: ${JSON.stringify(raw)}`);
  }
  return context;
}

function parseChoice<T extends string>(key: string, raw: string | undefined, fallback: T, choices: readonly T[]): T {
  if (raw === undefined) {
    return fallback;
  }
  if (!(choices as readonly string[]).includes(raw)) {
    throw new UserError(`config ${key} must be one of ${choices.join(", ")}: ${JSON.stringify(raw)}`);
  }
  return raw as T;
}

/** Read this repository's Cabaret settings. */
export async function readConfig(backend: Backend): Promise<Config> {
  const [method, via, context, style] = await Promise.all([
    backend.config("cabaret.landMethod"),
    backend.config("cabaret.landVia"),
    backend.config("cabaret.context"),
    backend.config("cabaret.workspaceStyle"),
  ]);
  return {
    landMethod: parseChoice("cabaret.landMethod", method, "merge", landMethods),
    landVia: parseChoice("cabaret.landVia", via, "auto", landVias),
    context: context === undefined ? undefined : parseContext(context, "config cabaret.context"),
    workspaceStyle: parseChoice("cabaret.workspaceStyle", style, "shared", workspaceStyles),
  };
}

/**
 * One Cabaret setting: a `cabaret.*` config key and how to write it.
 * Settings that describe the person (their aliases, how they read diffs)
 * default to global config; repository policy defaults to local config.
 */
export interface Setting {
  /** The name the `config` command uses. */
  readonly name: string;
  /** The config key holding the value. */
  readonly key: string;
  /** Where writes land when no flag picks a scope. */
  readonly scope: ConfigScope;
  /** Whether the key accumulates values rather than holding one. */
  readonly multi: boolean;
  /** What the setting controls, for help text. */
  readonly brief: string;
  /** The value an unset key behaves as, or undefined when unset means none. */
  readonly fallback: string | undefined;
  /** Parse a raw value into the string to store, rejecting bad ones. */
  readonly parse: (raw: string) => string;
}

export const settings: readonly Setting[] = [
  {
    name: "alias",
    key: "cabaret.alias",
    scope: "global",
    multi: true,
    brief: "Identities that also count as you",
    fallback: undefined,
    parse(raw) {
      if (raw === "") {
        throw new UserError("alias must be nonempty");
      }
      return raw;
    },
  },
  {
    name: "context",
    key: "cabaret.context",
    scope: "global",
    multi: false,
    brief: "Lines of diff context, -1 for whole files",
    fallback: String(defaultContext),
    parse: (raw) => String(parseContext(raw)),
  },
  {
    name: "land-method",
    key: "cabaret.landMethod",
    scope: "local",
    multi: false,
    brief: "How a land writes a change onto its parent: merge or squash",
    fallback: "merge",
    parse: (raw) => parseChoice("cabaret.landMethod", raw, "merge", landMethods),
  },
  {
    name: "land-via",
    key: "cabaret.landVia",
    scope: "local",
    multi: false,
    brief: "Where a land executes: local, forge, or auto",
    fallback: "auto",
    parse: (raw) => parseChoice("cabaret.landVia", raw, "auto", landVias),
  },
  {
    name: "workspace-style",
    key: "cabaret.workspaceStyle",
    scope: "local",
    multi: false,
    brief: "Where going to a change with no workspace checks it out: shared or dedicated",
    fallback: "shared",
    parse: (raw) => parseChoice("cabaret.workspaceStyle", raw, "shared", workspaceStyles),
  },
];

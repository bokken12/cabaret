import { buildCommand, buildRouteMap } from "@stricli/core";
import {
  type Backend,
  type ConfigScope,
  type ForgeAccountScheme,
  forgeAccount,
  forgeAccountSchemes,
  type Setting,
  settings,
  UserError,
  type UserName,
} from "cabaret-core";
import type { LocalContext } from "../context.js";

/** Column width that aligns values after the longest setting name. */
const settingNameWidth = Math.max(...settings.map((s) => s.name.length));

/** The git-style scope flags every config subcommand takes. */
const scopeFlags = {
  global: { kind: "boolean", brief: "Use the person's global git config", default: false },
  local: { kind: "boolean", brief: "Use this repository's git config", default: false },
} as const;

interface ScopeFlags {
  readonly global: boolean;
  readonly local: boolean;
}

/** The scope `flags` pick, or undefined when they pick none. */
function flaggedScope(flags: ScopeFlags): ConfigScope | undefined {
  if (flags.global && flags.local) {
    throw new UserError("pass at most one of --global and --local");
  }
  return flags.global ? "global" : flags.local ? "local" : undefined;
}

/** The scope a write to `setting` targets: the flagged one, or the setting's home. */
function writeScope(setting: Setting, flags: ScopeFlags): ConfigScope {
  return flaggedScope(flags) ?? setting.scope;
}

/** Render `setting`'s values as one line: `scope`'s alone, or all scopes merged. */
async function shownValue(backend: Backend, setting: Setting, scope: ConfigScope | undefined): Promise<string> {
  const values = await backend.configAll(setting.key, scope);
  if (values.length > 0) {
    return values.join(", ");
  }
  // What a setting defaults to only holds for the merged view; one scope's
  // gap may be filled by the other, so it is just unset.
  if (scope !== undefined) {
    return "(unset)";
  }
  return setting.fallback !== undefined ? `${setting.fallback} (default)` : "(none)";
}

/** The command for single-valued `setting`: show bare, set with a value, clear with --unset. */
function settingCommand(setting: Setting) {
  return buildCommand({
    docs: { brief: setting.brief },
    parameters: {
      positional: {
        kind: "tuple",
        parameters: [
          {
            brief: "value to set (shows the current value when omitted)",
            placeholder: "value",
            parse: String,
            optional: true,
          },
        ],
      },
      flags: {
        ...scopeFlags,
        unset: { kind: "boolean", brief: "Unset the setting, restoring its default", default: false },
      },
    },
    async func(this: LocalContext, flags: ScopeFlags & { unset: boolean }, value?: string) {
      const backend = await this.backend();
      if (flags.unset) {
        if (value !== undefined) {
          throw new UserError("pass a value or --unset, not both");
        }
        const scope = writeScope(setting, flags);
        if (!(await backend.configUnset(setting.key, scope))) {
          throw new UserError(`git config ${setting.key} has no ${scope} value`);
        }
      } else if (value !== undefined) {
        await backend.configSet(setting.key, setting.parse(value), writeScope(setting, flags));
      } else {
        this.process.stdout.write(`${await shownValue(backend, setting, flaggedScope(flags))}\n`);
      }
    },
  });
}

/**
 * The route map for one forge's aliases: accounts are named bare and stored
 * under the forge's scheme, so nobody has to spell `github:alice` by hand.
 */
function forgeAliasRouteMap(setting: Setting, scheme: ForgeAccountScheme) {
  const account = (raw: string): UserName => {
    if (raw === "" || raw.includes("@") || raw.includes(":")) {
      throw new UserError(`pass the bare account name, e.g. \`cabaret config alias ${scheme} add alice\``);
    }
    return forgeAccount(scheme, raw);
  };
  const positional = {
    kind: "tuple",
    parameters: [{ brief: "account name, without the scheme", placeholder: "account", parse: String }],
  } as const;
  return buildRouteMap({
    docs: { brief: `${setting.brief}, as bare ${scheme} accounts` },
    routes: {
      add: buildCommand({
        docs: { brief: "Add an account" },
        parameters: { positional, flags: scopeFlags },
        async func(this: LocalContext, flags: ScopeFlags, raw: string) {
          const value = account(raw);
          const scope = writeScope(setting, flags);
          const backend = await this.backend();
          if ((await backend.configAll(setting.key, scope)).includes(value)) {
            throw new UserError(
              `git config ${setting.key} already contains ${JSON.stringify(value)} in ${scope} config`,
            );
          }
          await backend.configAdd(setting.key, value, scope);
        },
      }),
      remove: buildCommand({
        docs: { brief: "Remove an account" },
        parameters: { positional, flags: scopeFlags },
        async func(this: LocalContext, flags: ScopeFlags, raw: string) {
          const value = account(raw);
          const scope = writeScope(setting, flags);
          const backend = await this.backend();
          if (!(await backend.configUnset(setting.key, scope, value))) {
            throw new UserError(`git config ${setting.key} has no ${scope} value ${JSON.stringify(value)}`);
          }
        },
      }),
      clear: buildCommand({
        docs: { brief: `Remove every ${scheme} account` },
        parameters: { flags: scopeFlags },
        async func(this: LocalContext, flags: ScopeFlags) {
          const scope = writeScope(setting, flags);
          const backend = await this.backend();
          const accounts = (await backend.configAll(setting.key, scope)).filter((value) =>
            value.startsWith(`${scheme}:`),
          );
          if (accounts.length === 0) {
            throw new UserError(`git config ${setting.key} has no ${scope} ${scheme} accounts`);
          }
          for (const value of accounts) {
            await backend.configUnset(setting.key, scope, value);
          }
        },
      }),
    },
  });
}

/** The route map for multi-valued `setting`: values are added and removed, not set. */
function settingRouteMap(setting: Setting) {
  return buildRouteMap({
    docs: { brief: setting.brief },
    routes: {
      add: buildCommand({
        docs: { brief: "Add a value" },
        parameters: {
          positional: {
            kind: "tuple",
            parameters: [{ brief: "value to add", placeholder: "value", parse: String }],
          },
          flags: scopeFlags,
        },
        async func(this: LocalContext, flags: ScopeFlags, raw: string) {
          const scope = writeScope(setting, flags);
          const value = setting.parse(raw);
          const backend = await this.backend();
          if ((await backend.configAll(setting.key, scope)).includes(value)) {
            throw new UserError(
              `git config ${setting.key} already contains ${JSON.stringify(value)} in ${scope} config`,
            );
          }
          await backend.configAdd(setting.key, value, scope);
        },
      }),
      remove: buildCommand({
        docs: { brief: "Remove a value" },
        parameters: {
          positional: {
            kind: "tuple",
            parameters: [{ brief: "value to remove", placeholder: "value", parse: String }],
          },
          flags: scopeFlags,
        },
        async func(this: LocalContext, flags: ScopeFlags, value: string) {
          const scope = writeScope(setting, flags);
          const backend = await this.backend();
          if (!(await backend.configUnset(setting.key, scope, value))) {
            throw new UserError(`git config ${setting.key} has no ${scope} value ${JSON.stringify(value)}`);
          }
        },
      }),
      clear: buildCommand({
        docs: { brief: "Remove every value" },
        parameters: { flags: scopeFlags },
        async func(this: LocalContext, flags: ScopeFlags) {
          const scope = writeScope(setting, flags);
          const backend = await this.backend();
          if (!(await backend.configUnset(setting.key, scope))) {
            throw new UserError(`git config ${setting.key} has no ${scope} value`);
          }
        },
      }),
      // Aliases get a route per forge, taking bare account names.
      ...(setting.key === "cabaret.alias"
        ? Object.fromEntries(forgeAccountSchemes.map((scheme) => [scheme, forgeAliasRouteMap(setting, scheme)]))
        : {}),
    },
  });
}

export const config = buildRouteMap({
  docs: {
    brief: "Manage Cabaret's settings",
    fullDescription:
      "Manage Cabaret's settings, stored as `cabaret.*` git config keys. " +
      "Each setting is a command: bare it shows the value, with a value it " +
      "sets it. Without --global or --local, settings of the person (alias, " +
      "context) go to global config, and settings of the repository " +
      "(land-method, land-via) to local config.",
  },
  routes: {
    list: buildCommand({
      docs: { brief: "Show every setting" },
      parameters: { flags: scopeFlags },
      async func(this: LocalContext, flags: ScopeFlags) {
        const scope = flaggedScope(flags);
        const backend = await this.backend();
        for (const setting of settings) {
          const shown = await shownValue(backend, setting, scope);
          this.process.stdout.write(`${setting.name.padEnd(settingNameWidth)}  ${shown}\n`);
        }
      },
    }),
    ...Object.fromEntries(settings.map((s) => [s.name, s.multi ? settingRouteMap(s) : settingCommand(s)])),
  },
});

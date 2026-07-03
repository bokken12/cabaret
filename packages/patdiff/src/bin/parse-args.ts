/** Minimal hand-rolled argument parser modelled after Jane Street's
 *  [Core.Command.Param.flag]. Handles only the flag shapes that the
 *  patdiff CLI actually uses. */

export type FlagSpec =
  | { readonly kind: "noArg" }
  | { readonly kind: "int" }
  | { readonly kind: "bool" }
  | { readonly kind: "string" }
  // [listed]: accumulates each occurrence.
  | { readonly kind: "stringList" };

export type FlagDef = {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly spec: FlagSpec;
};

export type ParseResult = {
  /** Map from canonical flag name to:
   *   - boolean for [noArg]
   *   - number for [int]
   *   - string for [string]
   *   - string[] for [stringList]
   *   - "true"|"false" parsed to boolean for [bool]
   *  Absent flags have no entry. */
  readonly flags: ReadonlyMap<string, FlagValue>;
  readonly positional: readonly string[];
};

export type FlagValue =
  | { readonly kind: "noArg"; readonly value: true }
  | { readonly kind: "int"; readonly value: number }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "stringList"; readonly value: readonly string[] };

// OCaml [Command] also accepts a leading [--] form for [-foo].
const normalize = (raw: string): string => {
  if (raw.startsWith("--")) return "-" + raw.slice(2);
  return raw;
};

const parseInt10 = (s: string): number => {
  if (!/^-?\d+$/.test(s)) {
    throw new Error(`Expected integer, got: ${s}`);
  }
  return Number.parseInt(s, 10);
};

const parseBool = (s: string): boolean => {
  const v = s.toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(`Expected bool, got: ${s}`);
};

export const parseArgs = (argv: readonly string[], defs: readonly FlagDef[]): ParseResult => {
  // Build a lookup table from flag name (with leading "-") to its definition.
  const byName = new Map<string, FlagDef>();
  for (const def of defs) {
    byName.set(`-${def.name}`, def);
    for (const a of def.aliases ?? []) byName.set(`-${a}`, def);
  }

  const flags = new Map<string, FlagValue>();
  const positional: string[] = [];
  let stopFlags = false;

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (stopFlags) {
      positional.push(raw);
      continue;
    }
    if (raw === "--") {
      stopFlags = true;
      continue;
    }
    if (!raw.startsWith("-") || raw === "-") {
      positional.push(raw);
      continue;
    }
    const normalized = normalize(raw);
    // Allow [-flag=value] for non-noArg flags.
    let flagName = normalized;
    let inlineValue: string | undefined;
    const eqIdx = normalized.indexOf("=");
    if (eqIdx > 0) {
      flagName = normalized.slice(0, eqIdx);
      inlineValue = normalized.slice(eqIdx + 1);
    }
    const def = byName.get(flagName);
    if (def === undefined) {
      throw new Error(`Unknown flag: ${raw}`);
    }
    const take = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error(`Flag ${raw} requires an argument`);
      }
      i += 1;
      return next;
    };
    switch (def.spec.kind) {
      case "noArg": {
        if (inlineValue !== undefined) {
          throw new Error(`Flag ${raw} does not take a value`);
        }
        flags.set(def.name, { kind: "noArg", value: true });
        break;
      }
      case "int": {
        flags.set(def.name, { kind: "int", value: parseInt10(take()) });
        break;
      }
      case "bool": {
        flags.set(def.name, { kind: "bool", value: parseBool(take()) });
        break;
      }
      case "string": {
        flags.set(def.name, { kind: "string", value: take() });
        break;
      }
      case "stringList": {
        const cur = flags.get(def.name);
        const list = cur?.kind === "stringList" ? [...cur.value] : [];
        list.push(take());
        flags.set(def.name, { kind: "stringList", value: list });
        break;
      }
    }
  }

  return { flags, positional };
};

// ----- typed getters -------------------------------------------------------

export const getNoArg = (res: ParseResult, name: string): boolean => {
  const v = res.flags.get(name);
  if (v === undefined) return false;
  if (v.kind !== "noArg") throw new Error(`Flag ${name}: expected noArg`);
  return true;
};

export const getInt = (res: ParseResult, name: string): number | undefined => {
  const v = res.flags.get(name);
  if (v === undefined) return undefined;
  if (v.kind !== "int") throw new Error(`Flag ${name}: expected int`);
  return v.value;
};

export const getBool = (res: ParseResult, name: string): boolean | undefined => {
  const v = res.flags.get(name);
  if (v === undefined) return undefined;
  if (v.kind !== "bool") throw new Error(`Flag ${name}: expected bool`);
  return v.value;
};

export const getString = (res: ParseResult, name: string): string | undefined => {
  const v = res.flags.get(name);
  if (v === undefined) return undefined;
  if (v.kind !== "string") throw new Error(`Flag ${name}: expected string`);
  return v.value;
};

export const getStringList = (res: ParseResult, name: string): readonly string[] => {
  const v = res.flags.get(name);
  if (v === undefined) return [];
  if (v.kind !== "stringList") throw new Error(`Flag ${name}: expected stringList`);
  return v.value;
};

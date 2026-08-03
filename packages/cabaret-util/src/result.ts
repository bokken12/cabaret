import { Option, type Maybe, type NotUndefined } from "./index.ts";

export type T<Ok, Err> = { kind: "ok"; ok: Ok } | { kind: "err"; err: Err };

export function ok<Ok extends NotUndefined.T, Err>(t: T<Ok, Err>): Maybe.T<Ok> {
  if (t.kind === "err") {
    return undefined;
  }
  return t.ok;
}

export function ok_opt<Ok, Err>(t: T<Ok, Err>): Option.T<Ok> {
  if (t.kind === "err") {
    return Option.none;
  }
  return Option.some(t.ok);
}

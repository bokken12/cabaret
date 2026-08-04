import { Maybe, NotUndefined, Option } from "./index.ts";

export type T<Ok, Err> = { kind: "ok"; ok: Ok } | { kind: "err"; err: Err };

export function make<Ok, Err>(ok: Ok): T<Ok, Err> {
  return { kind: "ok", ok };
}

export function make_err<Ok, Err>(err: Err): T<Ok, Err> {
  return { kind: "err", err };
}

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

  return Option.make(t.ok);
}

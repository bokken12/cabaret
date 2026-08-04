import { ADT, Maybe, match, NotUndefined, Option } from "./index.ts";

export type T<Ok, Err> = ADT<{ ok: { ok: Ok }; err: { err: Err } }>;

export function Ok<Ok, Err>(ok: Ok): T<Ok, Err> {
  return { kind: "ok", ok };
}

export function Err<Ok, Err>(err: Err): T<Ok, Err> {
  return { kind: "err", err };
}

export function ok<Ok extends NotUndefined.T, Err>(t: T<Ok, Err>): Maybe.T<Ok> {
  return match(t, {
    err: (_) => undefined,
    ok: (t) => t.ok,
  });
}

export function okOpt<Ok, Err>(t: T<Ok, Err>): Option.T<Ok> {
  return match(t, {
    err: (_) => Option.None,
    ok: (t) => Option.Some(t.ok),
  });
}

export function map<A, B, Err>(t: T<A, Err>, f: (a: A) => B): T<B, Err> {
  return match(t, {
    err: (t) => t,
    ok: (t) => Ok(f(t.ok)),
  });
}

export function mapErr<Ok, A, B>(t: T<Ok, A>, f: (a: A) => B): T<Ok, B> {
  return match(t, {
    ok: (t) => t,
    err: (t) => Err(f(t.err)),
  });
}

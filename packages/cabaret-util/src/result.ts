import { Enum, Maybe, match, NotUndefined, Option } from "./index.ts";

export type T<Ok, Err> = Enum<{ Ok: { ok: Ok }; Err: { err: Err } }>;

export function Ok<Ok, Err>(ok: Ok): T<Ok, Err> {
  return { kind: "Ok", ok };
}

export function Err<Ok, Err>(err: Err): T<Ok, Err> {
  return { kind: "Err", err };
}

export function ok<Ok extends NotUndefined.T, Err>(t: T<Ok, Err>): Maybe.T<Ok> {
  return match(t, {
    Err: (_) => undefined,
    Ok: (t) => t.ok,
  });
}

export function okOpt<Ok, Err>(t: T<Ok, Err>): Option.T<Ok> {
  return match(t, {
    Err: (_) => Option.None,
    Ok: (t) => Option.Some(t.ok),
  });
}

export function map<A, B, Err>(t: T<A, Err>, f: (a: A) => B): T<B, Err> {
  return match(t, {
    Err: (t) => t,
    Ok: (t) => Ok(f(t.ok)),
  });
}

export function mapErr<Ok, A, B>(t: T<Ok, A>, f: (a: A) => B): T<Ok, B> {
  return match(t, {
    Ok: (t) => t,
    Err: (t) => Err(f(t.err)),
  });
}

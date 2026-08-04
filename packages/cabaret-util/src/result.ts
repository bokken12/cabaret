import { Maybe, NotUndefined, Option, Variant } from "./index.ts";

export type T<Ok, Err> = { readonly kind: "ok"; readonly ok: Ok } | { readonly kind: "err"; readonly err: Err };

export function make<Ok, Err>(ok: Ok): T<Ok, Err> {
  return { kind: "ok", ok };
}

export function makeErr<Ok, Err>(err: Err): T<Ok, Err> {
  return { kind: "err", err };
}

export function ok<Ok extends NotUndefined.T, Err>(t: T<Ok, Err>): Maybe.T<Ok> {
  return Variant.match(t, {
    err: (_) => undefined,
    ok: (t) => t.ok,
  });
}

export function okOpt<Ok, Err>(t: T<Ok, Err>): Option.T<Ok> {
  return Variant.match(t, {
    err: (_) => Option.none,
    ok: (t) => Option.make(t.ok),
  });
}

export function map<A, B, Err>(t: T<A, Err>, f: (a: A) => B): T<B, Err> {
  return Variant.match(t, {
    err: (t) => t,
    ok: (t) => make(f(t.ok)),
  });
}

export function mapErr<Ok, A, B>(t: T<Ok, A>, f: (a: A) => B): T<Ok, B> {
  return Variant.match(t, {
    ok: (t) => t,
    err: (t) => makeErr(f(t.err)),
  });
}

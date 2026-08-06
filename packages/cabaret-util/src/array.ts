import { match, Result } from "./index.ts";

export type T<A> = A[];

export function partition<A, Ok, Err>(t: T<A>, f: (a: A) => Result.T<Ok, Err>): [oks: T<Ok>, errs: T<Err>] {
  const oks: T<Ok> = [];
  const errs: T<Err> = [];

  for (const a of t) {
    match(f(a), {
      Ok: (r) => oks.push(r.ok),
      Err: (r) => errs.push(r.err),
    });
  }

  return [oks, errs];
}

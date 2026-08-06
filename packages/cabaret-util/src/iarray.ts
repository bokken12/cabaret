import { match, Result } from "./index.ts";

/** Immutable array. */
export type T<A> = readonly A[];

export function partition<A, Ok, Err>(t: T<A>, f: (a: A) => Result.T<Ok, Err>): [oks: T<Ok>, errs: T<Err>] {
  const oks: Ok[] = [];
  const errs: Err[] = [];

  for (const a of t) {
    match(f(a), {
      Ok: (r) => oks.push(r.ok),
      Err: (r) => errs.push(r.err),
    });
  }

  return [oks, errs];
}

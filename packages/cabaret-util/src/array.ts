import { match, Result, Summable } from "./index.ts";

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

export function sum<A>(M: Summable.S<A>, t: T<A>): A;
export function sum<A, B>(M: Summable.S<B>, t: T<A>, f: (a: A) => B): B;
export function sum<B>(M: Summable.S<B>, t: T<any>, f?: (a: any) => B): B {
  return t.reduce((acc, a) => M.add(acc, f ? f(a) : a), M.zero);
}

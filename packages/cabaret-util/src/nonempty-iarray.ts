import { Iarray, Maybe } from "./index.ts";

export type T<A> = readonly [A, ...A[]];

export function is<A>(iarray: Iarray.T<A>): iarray is T<A> {
  return iarray.length > 0;
}

export function ofIarray<A>(iarray: Iarray.T<A>): Maybe.T<T<A>> {
  return Maybe.makeIf(iarray, is);
}

export function map<A, B>(t: T<A>, f: (a: A) => B): T<B> {
  const [head, ...tail] = t;
  return [f(head), ...tail.map(f)];
}

export function reduce<A>(t: T<A>, f: (acc: A, a: A) => A): A {
  const [head, ...tail] = t;
  return tail.reduce(f, head);
}

import { IArray, Maybe } from "./index.ts";

export type T<A> = readonly [A, ...A[]];

export function is<A>(iarray: IArray.T<A>): iarray is T<A> {
  return iarray.length > 0;
}

export function of_iarray<A>(iarray: IArray.T<A>): Maybe.T<T<A>> {
  return Maybe.make_if(iarray, is);
}

export function map<A, B>(t: T<A>, f: (a: A) => B): T<B> {
  const [head, ...tail] = t;
  return [f(head), ...tail.map(f)];
}

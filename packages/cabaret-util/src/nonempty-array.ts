import { Array, Maybe } from "./index.ts";

export type T<A> = [A, ...A[]];

export function is<A>(array: Array.T<A>): array is T<A> {
  return array.length > 0;
}

export function ofArray<A>(array: Array.T<A>): Maybe.T<T<A>> {
  return Maybe.makeIf(array, is);
}

export function map<A, B>(t: T<A>, f: (a: A) => B): T<B> {
  const [head, ...tail] = t;
  return [f(head), ...tail.map(f)];
}

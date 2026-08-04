import { NonNull } from "./index.ts";

export type T<A extends NonNull.T> = A | null;

export function map<A extends NonNull.T, B extends NonNull.T>(t: T<A>, f: (a: A) => B): T<B> {
  if (t === null) {
    return null;
  }

  return f(t);
}

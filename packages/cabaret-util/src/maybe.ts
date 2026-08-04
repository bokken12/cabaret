import { NotUndefined } from "./index.ts";

/** The default "optional" type. See also `Option.T` when a proper sum type is needed. */
export type T<A extends NotUndefined.T> = A | undefined;

export function map<A extends NotUndefined.T, B extends NotUndefined.T>(t: T<A>, f: (a: A) => B): T<B> {
  if (t === undefined) {
    return undefined;
  }

  return f(t);
}

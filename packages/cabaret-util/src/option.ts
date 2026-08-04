import { Maybe, NotUndefined } from "./index.ts";

/** Optional type via discriminated union. See also `Maybe.T` for niche optimization. */
export type T<A> = { readonly kind: "some"; readonly val: A } | { readonly kind: "none" };

export const none: T<never> = { kind: "none" };

export function make<A>(a: A): T<A> {
  return { kind: "some", val: a };
}

export function makeIf<A, B extends A>(a: A, is: (a: A) => a is B): T<B> {
  if (!is(a)) {
    return none;
  }

  return make(a);
}

export function ofMaybe<A extends NotUndefined.T>(maybe: Maybe.T<A>): T<A> {
  return makeIf(maybe, (a): a is A => a !== undefined);
}

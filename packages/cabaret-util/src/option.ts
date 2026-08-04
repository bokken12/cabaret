/** Optional type via discriminated union. See also `Maybe.T` for niche optimization. */
export type T<A> = { kind: "some"; val: A } | { kind: "none" };

export const none: T<never> = { kind: "none" };

export function make<A>(a: A): T<A> {
  return { kind: "some", val: a };
}

export function make_if<A, B extends A>(a: A, is: (a: A) => a is B): T<B> {
  if (!is(a)) {
    return none;
  }

  return make(a);
}

import { Enum, Maybe, NotUndefined } from "./index.ts";

/** Optional type via discriminated union. See also `Maybe.T` for niche optimization. */
export type T<A> = Enum<{ Some: { val: A }; None: {} }>;

export const None: T<never> = { kind: "None" };

export function Some<A>(a: A): T<A> {
  return { kind: "Some", val: a };
}

export function makeIf<A, B extends A>(a: A, is: (a: A) => a is B): T<B> {
  if (!is(a)) {
    return None;
  }

  return Some(a);
}

export function ofMaybe<A extends NotUndefined.T>(maybe: Maybe.T<A>): T<A> {
  return makeIf(maybe, (a): a is A => a !== undefined);
}

type Gen<A> = Generator<undefined, A, never>;

export function* bind<A>(t: T<A>): Gen<A> {
  if (t.kind === "None") {
    return yield undefined;
  }

  return t.val;
}

export function gen<A>(body: () => Gen<A>): T<A> {
  const result = body().next();

  if (!result.done) {
    return None;
  }

  return Some(result.value);
}

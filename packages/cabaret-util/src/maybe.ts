import { match, NoResume, NotUndefined, Option } from "./index.ts";

type NU = NotUndefined.T;

/** The default "optional" type. See also `Option.T` when a proper sum type is needed. */
export type T<A extends NU> = A | undefined;

export function makeIf<A, B extends A & NU>(a: A, is: (a: A) => a is B): T<B> {
  if (!is(a)) {
    return undefined;
  }

  return a;
}

export function value<A extends NU>(t: T<A>, default_: A): A {
  return match(t, {
    undefined: () => default_,
    _: (t) => t,
  });
}

export function valueExn<A extends NU>(t: T<A>): A {
  return match(t, {
    undefined: () => {
      throw new Error("Maybe.valueExn: undefined");
    },
    _: (t) => t,
  });
}

export function map<A extends NU, B extends NU>(t: T<A>, f: (a: A) => B): T<B> {
  return match(t, {
    undefined: () => undefined,
    _: (t) => f(t),
  });
}

export function toOption<A extends NU>(t: T<A>): Option.T<A> {
  return Option.makeIf(t, (a): a is A => a !== undefined);
}

type Gen<A> = Generator<undefined, A, NoResume.T>;

export function* bind<A extends NU>(t: T<A>): Gen<A> {
  if (t === undefined) {
    return NoResume.absurd(yield undefined);
  }

  return t;
}

export function gen<A extends NU>(body: () => Gen<A>): T<A> {
  const result = body().next();

  if (!result.done) {
    return undefined;
  }

  return result.value;
}

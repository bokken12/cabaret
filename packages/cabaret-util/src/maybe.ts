import { match, NotUndefined, Option } from "./index.ts";

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

// declare const GEN_IN: unique symbol;
// declare const GEN_OUT: unique symbol;

// type GenIn = typeof GEN_IN;
// type GenOut = typeof GEN_OUT;

// type Gen<A> = Generator<GenIn, A, GenOut>

// function bind<A extends NU>(T<A>): Gen<A>

// function gen<A>(body: () => Gen<A>): T<A> {

// }

// if undefined -> never
// if A -> A

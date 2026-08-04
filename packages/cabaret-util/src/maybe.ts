import { NotUndefined, Option } from "./index.ts";

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
  if (t === undefined) {
    return default_;
  }

  return t;
}

export function valueExn<A extends NU>(t: T<A>): A {
  if (t === undefined) {
    throw new Error("Maybe.valueExn: undefined");
  }

  return t;
}

export function map<A extends NU, B extends NU>(t: T<A>, f: (a: A) => B): T<B> {
  if (t === undefined) {
    return undefined;
  }

  return f(t);
}

export function toOption<A extends NU>(t: T<A>): Option.T<A> {
  return Option.makeIf(t, (a): a is A => a !== undefined);
}

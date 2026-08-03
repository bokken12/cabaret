export type T<A> = A | undefined;

export function map<A, B>(t: T<A>, f: (a: A) => B): T<B> {
  if (t === undefined) {
    return undefined;
  }

  return f(t);
}

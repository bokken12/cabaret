export type T<A> = A | null;

export function map<A, B>(t: T<A>, f: (a: A) => B): T<B> {
  if (t === null) {
    return null;
  }

  return f(t);
}

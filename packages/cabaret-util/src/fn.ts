export function constant<A>(a: A): (..._: unknown[]) => A {
  return () => a;
}

export function id<A>(a: A) {
  return a;
}

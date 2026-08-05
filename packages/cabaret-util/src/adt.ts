export type ADT<T extends Record<string, {}>> = {
  [K in keyof T]: { readonly kind: K } & Readonly<T[K]>;
}[keyof T];

type Literal = string | number | boolean | null | undefined;

type T = Literal | { readonly kind: string };

type Tag<A extends T> = A extends { kind: infer K extends string } ? K : A extends Literal ? `${A}` : never;

// `A extends T` is vacuous, but forces distribution
type Case<A extends T, P> = A extends T ? (P extends Tag<A> ? A : never) : never;

type Rest<A extends T, K> = A extends T ? (Tag<A> extends K ? never : A) : never;

export function match<A extends T, R>(a: A, handlers: { [P in Tag<A>]: (v: Case<A, P>) => R }): R;
export function match<A extends T, K extends Tag<A> | "_", R>(
  a: A,
  handlers: { [P in K | "_"]: (v: P extends "_" ? Rest<A, Exclude<K, "_">> : Case<A, P>) => R },
): R;
export function match(a: T, handlers: object): unknown {
  const h = handlers as Partial<Record<string, (v: unknown) => unknown>>;
  const tag = typeof a === "object" && a !== null ? a.kind : String(a);
  // `null` and `undefined` prefer to refer to their special values
  const ambiguous = a === "null" || a === "undefined";
  const handler = ambiguous ? (h["_"] ?? h[tag]) : (h[tag] ?? h["_"]);
  if (handler === undefined) {
    throw new Error(`unhandled case: ${tag}`);
  }

  return handler(a);
}

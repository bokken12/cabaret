// TODO-someday(jm): generate enum constructors
export type Enum<T extends Record<string, {}>> = {
  [K in keyof T]: { readonly kind: K } & Readonly<T[K]>;
}[keyof T];

// Exactly the primitives `${_}` accepts, i.e. those with a canonical string image; symbol
// is the lone primitive without one.
type Literal = string | number | boolean | bigint | null | undefined;

type T = Literal | { readonly kind: string };

type Tag<A> = A extends { kind: infer K extends string } ? K : A extends Literal ? `${A}` : never;

// `A extends T` distributes over A's members; members outside T have no tag, so they
// never reach a keyed case and always fall through to "_".
type Case<A, P> = A extends T ? (P extends Tag<A> ? A : never) : never;

type Rest<A, K> = A extends T ? (Tag<A> extends K ? never : A) : A;

// TODO-someday(jm): consider using $ as a separator either for match2 or for disjunction
export function match<A extends T, R>(a: A, handlers: { [P in Tag<A>]: (v: Case<A, P>) => R }): R;
export function match<A, K extends Tag<A> | "_", R>(
  a: A,
  handlers: { [P in K | "_"]: (v: P extends "_" ? Rest<A, Exclude<K, "_">> : Case<A, P>) => R },
): R;
export function match(a: unknown, handlers: object): unknown {
  const h = handlers as Partial<Record<string, (v: unknown) => unknown>>;
  // Mirrors Tag: literals stringify; everything else dispatches on its kind, if any
  const tag =
    a !== null && (typeof a === "object" || typeof a === "function" || typeof a === "symbol")
      ? (a as { kind?: unknown }).kind
      : String(a);
  const keyed = typeof tag === "string" ? h[tag] : undefined;
  // `null` and `undefined` prefer to refer to their special values
  const ambiguous = a === "null" || a === "undefined";
  const handler = ambiguous ? (h["_"] ?? keyed) : (keyed ?? h["_"]);
  if (handler === undefined) {
    throw new Error(`unhandled case: ${String(tag)}`);
  }

  return handler(a);
}

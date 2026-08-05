// TODO-someday(jm): generate enum constructors
// TODO-someday(jm): ban reserved kinds
export type Enum<T extends Record<string, {}>> = {
  [K in keyof T]: { readonly kind: K } & Readonly<T[K]>;
}[keyof T];

// Primitives with a canonical string representation in `${_}`
type Literal = string | number | boolean | bigint | null | undefined;

type T = Literal | { readonly kind: string };

// reserved nullish strings always route to _ in partial matches
type Reserved = "null" | "undefined";

type PartialTag<A> = A extends null
  ? "null"
  : A extends undefined
    ? "undefined"
    : A extends Reserved
      ? never
      : A extends { kind: infer K extends string }
        ? Exclude<K, Reserved>
        : A extends Literal
          ? `${A}`
          : never;

// Vacuous `A extends unknown` just triggers distribution
type PartialCase<A, P> = A extends unknown ? (P extends PartialTag<A> ? A : never) : never;

type Rest<A, K> = A extends unknown
  ? [PartialTag<A>] extends [never]
    ? A
    : PartialTag<A> extends K
      ? never
      : A
  : never;

type ExhaustiveTag<A> = A extends { kind: infer K extends string } ? K : A extends Literal ? `${A}` : never;

type ExhaustiveCase<A, P> = A extends unknown ? (P extends ExhaustiveTag<A> ? A : never) : never;

// TODO-someday(jm): consider using $ as a separator either for match2 or for disjunction
export function match<A, K extends PartialTag<A> | "_", R>(
  a: A,
  handlers: { [P in K | "_"]: (v: P extends "_" ? Rest<A, Exclude<K, "_">> : PartialCase<A, P>) => R },
): R;
export function match<A extends T, R>(a: A, handlers: { [P in ExhaustiveTag<A>]: (v: ExhaustiveCase<A, P>) => R }): R;
export function match(a: unknown, handlers: object): unknown {
  const h = handlers as Partial<Record<string, (v: unknown) => unknown>>;
  const tag =
    a !== null && (typeof a === "object" || typeof a === "function" || typeof a === "symbol")
      ? (a as { kind?: unknown }).kind
      : String(a);
  const keyed = typeof tag === "string" ? h[tag] : undefined;
  const reserved = (tag === "null" || tag === "undefined") && a !== null && a !== undefined;
  const handler = reserved ? (h["_"] ?? keyed) : (keyed ?? h["_"]);
  if (handler === undefined) {
    throw new Error(`unhandled case: ${String(tag)}`);
  }

  return handler(a);
}

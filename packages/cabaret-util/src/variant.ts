export type T = { kind: string };

type Case<A extends T, K> = A extends { kind: infer K2 } ? (K extends K2 ? A : never) : never;

type Rest<A extends T, K> = Exclude<A, { kind: K }>;

export function match<A extends T, R>(a: A, handlers: { [K in A["kind"]]: (v: Case<A, K>) => R }): R;
export function match<A extends T, K extends A["kind"] | "_", R>(
  a: A,
  handlers: { [P in K | "_"]: (v: P extends "_" ? Rest<A, K> : Case<A, P>) => R },
): R;
export function match<A extends T, R>(a: A, handlers: Partial<Record<string, (v: A) => R>>): R {
  const handler = handlers[a.kind] ?? handlers["_"];
  if (handler === undefined) {
    throw new Error(`unhandled kind: ${a.kind}`);
  }

  return handler(a);
}

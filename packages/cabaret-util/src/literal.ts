export type T = string | number | boolean | null | undefined;

type Case<A, P extends string | number> = A extends T ? (`${A}` extends `${P}` ? A : never) : never;

type Rest<A, K extends string | number> = A extends T ? (`${A}` extends `${K}` ? never : A) : A;

export function match<A extends T, R>(a: A, handlers: { [P in `${A}`]: (v: Case<A, P>) => R }): R;
export function match<A, K extends string | number, R>(
  a: A,
  handlers: { [P in K | "_"]: (v: P extends "_" ? Rest<A, Exclude<K, "_">> : Case<A, P>) => R },
): R;
export function match(a: unknown, handlers: object): unknown {
  const h = handlers as Partial<Record<string, (v: unknown) => unknown>>;
  const handler = h[String(a)] ?? h["_"];
  if (handler === undefined) {
    throw new Error(`unhandled literal: ${String(a)}`);
  }

  return handler(a);
}

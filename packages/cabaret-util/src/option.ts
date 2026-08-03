export type T<A> = { kind: "some"; val: A } | { kind: "none" };

export const none: T<never> = { kind: "none" };

export function some<A>(a: A): T<A> {
  return { kind: "some", val: a };
}

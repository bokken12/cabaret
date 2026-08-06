declare const brand: unique symbol;

/** `Generator` does not permit `never` resuming. Use this instead. */
export type T = { readonly [brand]: never };

export function absurd(_t: T): never {
  throw new Error("NoResume.absurd: generator resumed after yield");
}

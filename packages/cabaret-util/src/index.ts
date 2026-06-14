declare const brand: unique symbol;

/**
 * Nominal typing: a `T` tagged with a phantom `Brand` label, assignable to
 * `T` but not constructible without an explicit cast. Wrap that cast in a
 * single parse function per brand.
 */
export type Branded<T, Brand extends string> = T & {
  readonly [brand]: Brand;
};

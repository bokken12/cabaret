declare const brand: unique symbol;

/**
 * Map `items` through `fn` with at most `limit` calls in flight, preserving
 * input order in the results. A rejection propagates after the calls already
 * in flight settle; no further calls start.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(`concurrency limit must be a positive integer: ${limit}`);
  }
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (next < items.length && !failed) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Nominal typing: a `T` tagged with a phantom `Brand` label, assignable to
 * `T` but not constructible without an explicit cast. Wrap that cast in a
 * single parse function per brand. Labels accumulate as a record rather
 * than intersecting literal types, so brands refine: `Branded<Base, "Sub">`
 * is assignable to `Base` but not conversely.
 */
export type Branded<T, Brand extends string> = T & {
  readonly [brand]: { readonly [K in Brand]: true };
};

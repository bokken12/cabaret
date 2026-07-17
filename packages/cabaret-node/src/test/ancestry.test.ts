import { parseCommitHash } from "cabaret-core";
import { expect, test } from "vitest";
import { AncestryCache } from "../ancestry.js";

const A = parseCommitHash("a".repeat(40));
const B = parseCommitHash("b".repeat(40));
const M = parseCommitHash("c".repeat(40));

/** A compute function that counts its runs and resolves to `value`. */
function counted<T>(value: T): { compute: () => Promise<T>; runs: () => number } {
  let runs = 0;
  return {
    compute: () => {
      runs++;
      return Promise.resolve(value);
    },
    runs: () => runs,
  };
}

test("same-revision queries answer without computing", async () => {
  const cache = new AncestryCache();
  const never = () => {
    throw new Error("computed a trivial query");
  };
  expect(await cache.isAncestor(A, A, never)).toBe(true);
  expect(await cache.mergeBase(A, A, never)).toBe(A);
});

test("concurrent and repeated queries share one computation", async () => {
  const cache = new AncestryCache();
  const ancestry = counted(true);
  const both = await Promise.all([cache.isAncestor(A, B, ancestry.compute), cache.isAncestor(A, B, ancestry.compute)]);
  expect(both).toEqual([true, true]);
  expect(await cache.isAncestor(A, B, ancestry.compute)).toBe(true);
  expect(ancestry.runs()).toBe(1);

  const base = counted(M);
  await Promise.all([cache.mergeBase(A, B, base.compute), cache.mergeBase(A, B, base.compute)]);
  expect(await cache.mergeBase(A, B, base.compute)).toBe(M);
  expect(base.runs()).toBe(1);
});

test("a merge-base answers both argument orders", async () => {
  const cache = new AncestryCache();
  const base = counted(M);
  expect(await cache.mergeBase(A, B, base.compute)).toBe(M);
  expect(await cache.mergeBase(B, A, base.compute)).toBe(M);
  expect(base.runs()).toBe(1);
});

test("a merge-base settles the ancestries around it", async () => {
  const cache = new AncestryCache();
  const never = () => {
    throw new Error("computed a derivable query");
  };
  await cache.mergeBase(A, B, counted(M).compute);
  expect(await cache.isAncestor(M, A, never)).toBe(true);
  expect(await cache.isAncestor(M, B, never)).toBe(true);
  expect(await cache.isAncestor(A, B, never)).toBe(false);
  expect(await cache.isAncestor(B, A, never)).toBe(false);

  await cache.mergeBase(A, M, counted(M).compute);
  expect(await cache.isAncestor(M, A, never)).toBe(true);
  expect(await cache.isAncestor(A, M, never)).toBe(false);
});

test("a fact settled by a merge-base survives the failure it overtook", async () => {
  const cache = new AncestryCache();
  let reject: (error: Error) => void = () => {
    throw new Error("compute never started");
  };
  const doomed = cache.isAncestor(M, A, () => new Promise((_, r) => (reject = r)));
  await cache.mergeBase(A, B, counted(M).compute);
  reject(new Error("spawn failed"));
  await expect(doomed).rejects.toThrow("spawn failed");
  const never = () => {
    throw new Error("recomputed a settled fact");
  };
  expect(await cache.isAncestor(M, A, never)).toBe(true);
});

test("a failed computation is evicted, not pinned", async () => {
  const cache = new AncestryCache();
  const failed = () => Promise.reject(new Error("spawn failed"));
  await expect(cache.isAncestor(A, B, failed)).rejects.toThrow("spawn failed");
  await expect(cache.mergeBase(A, B, failed)).rejects.toThrow("spawn failed");
  expect(await cache.isAncestor(A, B, counted(true).compute)).toBe(true);
  expect(await cache.mergeBase(A, B, counted(M).compute)).toBe(M);
});

import fc from "fast-check";
import { expect, test } from "vitest";
import { mapConcurrent } from "../index.js";

/** Yield the microtask queue `turns` times, staggering completion order. */
async function stall(turns: number): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

test("mapConcurrent maps in input order whatever order calls finish in", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.nat(20), { maxLength: 30 }),
      fc.integer({ min: 1, max: 8 }),
      async (stalls, limit) => {
        const results = await mapConcurrent(stalls, limit, async (turns, index) => {
          await stall(turns);
          return index * 10;
        });
        expect(results).toEqual(stalls.map((_, index) => index * 10));
      },
    ),
  );
});

test("mapConcurrent keeps at most `limit` calls in flight", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.nat(10), { maxLength: 30 }),
      fc.integer({ min: 1, max: 4 }),
      async (stalls, limit) => {
        let inFlight = 0;
        let peak = 0;
        await mapConcurrent(stalls, limit, async (turns) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await stall(turns);
          inFlight -= 1;
        });
        expect(peak).toBeLessThanOrEqual(limit);
        expect(peak).toBe(Math.min(limit, stalls.length));
      },
    ),
  );
});

test("a rejection propagates and later items never start", async () => {
  const started: number[] = [];
  await expect(
    mapConcurrent([0, 1, 2, 3, 4, 5], 1, async (item) => {
      started.push(item);
      await stall(1);
      if (item === 1) {
        throw new Error("boom");
      }
    }),
  ).rejects.toThrow("boom");
  expect(started).toEqual([0, 1]);
});

test("mapConcurrent rejects a non-positive limit", async () => {
  await expect(mapConcurrent([1], 0, async (n) => n)).rejects.toThrow(
    "concurrency limit must be a positive integer: 0",
  );
});

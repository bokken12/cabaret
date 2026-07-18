import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BackoffLoop } from "../backoff.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("ticks immediately, then again after the base interval on success", async () => {
  const runs: number[] = [];
  const loop = new BackoffLoop({
    run: async () => {
      runs.push(runs.length);
    },
    baseIntervalMs: 1000,
    maxIntervalMs: 8000,
    isTransient: () => true,
  });
  loop.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(runs).toEqual([0]);
  await vi.advanceTimersByTimeAsync(999);
  expect(runs).toEqual([0]);
  await vi.advanceTimersByTimeAsync(1);
  expect(runs).toEqual([0, 1]);
  loop.dispose();
});

test("doubles the delay on each transient failure, capped, and resets on success", async () => {
  let shouldFail = true;
  const settled: string[] = [];
  const loop = new BackoffLoop({
    run: async () => {
      if (shouldFail) {
        throw new Error("offline");
      }
    },
    baseIntervalMs: 1000,
    maxIntervalMs: 3000,
    isTransient: () => true,
    onSettled: (result) => settled.push(result.ok ? "ok" : `fail(backingOff=${result.backingOff})`),
  });
  loop.start();
  await vi.advanceTimersByTimeAsync(0); // run 1: fails, interval 1000 -> 2000, next tick at t=2000
  await vi.advanceTimersByTimeAsync(2000); // run 2 at t=2000: fails, interval 2000 -> 3000 (capped), next tick at t=5000
  await vi.advanceTimersByTimeAsync(3000); // run 3 at t=5000: fails, interval stays capped at 3000, next tick at t=8000
  expect(settled).toEqual(["fail(backingOff=true)", "fail(backingOff=true)", "fail(backingOff=true)"]);
  shouldFail = false;
  await vi.advanceTimersByTimeAsync(3000); // run 4 at t=8000: succeeds, resets to base 1000, next tick at t=9000
  expect(settled.at(-1)).toBe("ok");
  await vi.advanceTimersByTimeAsync(999);
  expect(settled).toHaveLength(4);
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toHaveLength(5);
  loop.dispose();
});

test("a non-transient failure is reported but does not change the delay", async () => {
  const settled: string[] = [];
  const loop = new BackoffLoop({
    run: async () => {
      throw new Error("bad config");
    },
    baseIntervalMs: 1000,
    maxIntervalMs: 8000,
    isTransient: () => false,
    onSettled: (result) => settled.push(result.ok ? "ok" : `fail(backingOff=${result.backingOff})`),
  });
  loop.start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(1000);
  expect(settled).toEqual(["fail(backingOff=false)", "fail(backingOff=false)"]);
  loop.dispose();
});

test("runNow joins a run already in flight instead of starting a second one", async () => {
  let started = 0;
  let resolveRun: (() => void) | undefined;
  const loop = new BackoffLoop({
    run: () =>
      new Promise<void>((resolve) => {
        started += 1;
        resolveRun = resolve;
      }),
    baseIntervalMs: 1000,
    maxIntervalMs: 8000,
    isTransient: () => true,
  });
  loop.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(started).toBe(1);
  const joined = loop.runNow();
  expect(started).toBe(1);
  resolveRun?.();
  await joined;
  loop.dispose();
});

test("runNow preempts a pending scheduled tick", async () => {
  const runs: number[] = [];
  const loop = new BackoffLoop({
    run: async () => {
      runs.push(runs.length);
    },
    baseIntervalMs: 1000,
    maxIntervalMs: 8000,
    isTransient: () => true,
  });
  loop.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(runs).toEqual([0]);
  await loop.runNow();
  expect(runs).toEqual([0, 1]);
  // The preempted tick's timer was cleared, so it does not also fire at the
  // original schedule; the reschedule from `runNow`'s own completion does.
  await vi.advanceTimersByTimeAsync(999);
  expect(runs).toEqual([0, 1]);
  await vi.advanceTimersByTimeAsync(1);
  expect(runs).toEqual([0, 1, 2]);
  loop.dispose();
});

test("shouldRun gates scheduled ticks but not runNow", async () => {
  let enabled = false;
  const runs: number[] = [];
  const loop = new BackoffLoop({
    run: async () => {
      runs.push(runs.length);
    },
    baseIntervalMs: 1000,
    maxIntervalMs: 8000,
    isTransient: () => true,
    shouldRun: () => enabled,
  });
  loop.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(runs).toEqual([]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(runs).toEqual([]);
  await loop.runNow();
  expect(runs).toEqual([0]);
  enabled = true;
  await vi.advanceTimersByTimeAsync(1000);
  expect(runs).toEqual([0, 1]);
  loop.dispose();
});

import { PrNumber } from '@cabaret/core';

/**
 * Parse a positional PR-number argument. `usage` is interpolated into the
 * error message when the argument is missing, so each caller can show its
 * own command form (e.g. "cabaret status <PR>").
 */
export function parsePrArg(args: readonly string[], usage: string): PrNumber {
  const [first] = args;
  if (first === undefined) {
    throw new Error(`usage: ${usage}`);
  }
  const n = Number.parseInt(first, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== first) {
    throw new Error(`PR must be a positive integer; got "${first}"`);
  }
  return PrNumber(n);
}

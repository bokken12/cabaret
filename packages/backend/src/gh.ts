import { z } from 'zod';
import type { PrNumber } from '@cabaret/core';
import { exec } from './exec.js';

/**
 * Schema for the subset of `gh pr view --json <fields>` output we use.
 * This object is the single source of truth: both the parser and the
 * field list passed to `gh` are derived from it.
 */
const PrViewSchema = z.object({
  number: z.number(),
  title: z.string(),
  author: z.object({ login: z.string() }),
  baseRefName: z.string(),
  baseRefOid: z.string(),
  headRefName: z.string(),
  headRefOid: z.string(),
  url: z.string(),
});

export type GhPrView = z.infer<typeof PrViewSchema>;

/** Comma-separated field list for `gh pr view --json`, derived from the schema. */
const PR_VIEW_FIELDS = Object.keys(PrViewSchema.shape).join(',');

/**
 * Thin wrapper around the `gh` CLI. We rely on `gh` having been configured
 * for the current repo; cabaret does not authenticate independently.
 */
export class Gh {
  constructor(private readonly cwd: string) {}

  async prView(pr: PrNumber): Promise<GhPrView> {
    const { stdout } = await exec('gh', ['pr', 'view', String(pr), '--json', PR_VIEW_FIELDS], {
      cwd: this.cwd,
    });
    return parseGhPrView(stdout);
  }
}

export function parseGhPrView(raw: string): GhPrView {
  return PrViewSchema.parse(JSON.parse(raw));
}

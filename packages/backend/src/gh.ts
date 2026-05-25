import { CommitSha, type PrNumber } from '@cabaret/core';
import { exec } from './exec.js';

/**
 * What we ask the `gh` CLI for, per PR. Fields match `gh pr view --json` keys.
 */
export type GhPrView = {
  readonly number: number;
  readonly title: string;
  readonly author: { readonly login: string };
  readonly baseRefName: string;
  readonly baseRefOid: string;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly url: string;
};

const PR_VIEW_FIELDS = [
  'number',
  'title',
  'author',
  'baseRefName',
  'baseRefOid',
  'headRefName',
  'headRefOid',
  'url',
].join(',');

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

/**
 * Parse `gh pr view --json` output. We validate shape minimally — `gh`'s
 * output is stable and a richer schema validator would be over-engineered
 * for milestone 1.
 */
export function parseGhPrView(raw: string): GhPrView {
  const v: unknown = JSON.parse(raw);
  if (typeof v !== 'object' || v === null) {
    throw new Error(`gh pr view returned non-object: ${raw.slice(0, 200)}`);
  }
  const obj = v as Record<string, unknown>;
  const author = obj['author'];
  if (
    typeof obj['number'] !== 'number' ||
    typeof obj['title'] !== 'string' ||
    typeof obj['baseRefName'] !== 'string' ||
    typeof obj['baseRefOid'] !== 'string' ||
    typeof obj['headRefName'] !== 'string' ||
    typeof obj['headRefOid'] !== 'string' ||
    typeof obj['url'] !== 'string' ||
    typeof author !== 'object' || author === null ||
    typeof (author as Record<string, unknown>)['login'] !== 'string'
  ) {
    throw new Error(`gh pr view returned unexpected shape: ${raw.slice(0, 500)}`);
  }
  return {
    number: obj['number'],
    title: obj['title'],
    author: { login: (author as { login: string }).login },
    baseRefName: obj['baseRefName'],
    baseRefOid: obj['baseRefOid'],
    headRefName: obj['headRefName'],
    headRefOid: obj['headRefOid'],
    url: obj['url'],
  };
}

/**
 * Sentinel cast so callers can read `headRefOid` as `CommitSha` without
 * littering the implementation with conversions.
 */
export function ghCommit(s: string): CommitSha {
  return CommitSha(s);
}

import {
  type Brain,
  type FileState,
  markReviewed,
  Path,
  type PrNumber,
  Timestamp,
} from '@cabaret/core';
import type { Backend, PrInfo } from '@cabaret/backend';
import { parsePrArg } from './args.js';

/**
 * Implements `cabaret review <PR>`: advance the reviewer's brain for every
 * file changed by the PR.
 */
export async function runReview(backend: Backend, args: readonly string[]): Promise<void> {
  const pr = parsePrArg(args, 'cabaret review <PR>');
  process.stdout.write(await applyReview(backend, pr, null));
}

/**
 * Implements `cabaret review-file <PR> <path>`: advance the reviewer's
 * brain for a single file. The path must appear in the PR's changed files;
 * reviewing a path the PR doesn't touch is rejected rather than silently
 * creating a brain entry pointing at arbitrary blobs.
 */
export async function runReviewFile(backend: Backend, args: readonly string[]): Promise<void> {
  const [first, second, ...rest] = args;
  if (first === undefined || second === undefined || rest.length > 0) {
    throw new Error('usage: cabaret review-file <PR> <path>');
  }
  const pr = parsePrArg([first], 'cabaret review-file <PR> <path>');
  process.stdout.write(await applyReview(backend, pr, Path(second)));
}

/**
 * Shared body for both review commands. If `only` is set, restrict the
 * review to that single path and error if it isn't in the PR.
 */
async function applyReview(backend: Backend, pr: PrNumber, only: Path | null): Promise<string> {
  const [info, changes, user] = await Promise.all([
    backend.getPrInfo(pr),
    backend.getChangedFiles(pr),
    backend.currentUser(),
  ]);
  const files: readonly FileState[] = only === null ? changes : [findChange(changes, only, pr)];
  const brainEntries = await backend.readBrain(user, pr);
  const brain: Brain = {
    user,
    pr,
    entries: new Map(brainEntries.map((e) => [e.path, e])),
  };
  const result = markReviewed(brain, files, Timestamp(Date.now()));
  if (result.advanced.length > 0) {
    await backend.writeBrain(user, pr, [...result.brain.entries.values()]);
  }
  return renderReview(info, result.advanced);
}

function findChange(changes: readonly FileState[], target: Path, pr: PrNumber): FileState {
  const hit = changes.find((c) => c.path === target);
  if (!hit) {
    throw new Error(`"${target}" is not a changed file in PR #${String(pr)}`);
  }
  return hit;
}

export function renderReview(info: PrInfo, advanced: readonly Path[]): string {
  const lines: string[] = [];
  lines.push(`PR #${String(info.number)} — "${info.title}" by @${info.author}`);
  lines.push(`tip:  ${info.tipCommit}`);
  lines.push(`base: ${info.baseCommit} (${info.baseRef})`);
  lines.push('');
  const labelWidth = 12;
  for (const p of advanced) {
    lines.push(`  ${'reviewed'.padEnd(labelWidth)} ${p}`);
  }
  lines.push('');
  if (advanced.length === 0) {
    lines.push('nothing to review.');
  } else {
    lines.push(`${String(advanced.length)} file(s) reviewed.`);
  }
  return `${lines.join('\n')}\n`;
}

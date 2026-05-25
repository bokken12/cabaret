import { classifyPr, type FileStatus, PrNumber, type Brain } from '@cabaret/core';
import type { Backend, PrInfo } from '@cabaret/backend';

/**
 * Implements `cabaret status <PR>`: prints a per-file classification of a
 * PR's changes against the current user's brain.
 */
export async function runStatus(backend: Backend, args: readonly string[]): Promise<void> {
  const pr = parsePrArg(args);
  const [info, changes, user] = await Promise.all([
    backend.getPrInfo(pr),
    backend.getChangedFiles(pr),
    backend.currentUser(),
  ]);
  const brainEntries = await backend.readBrain(user, pr);
  const brain: Brain = {
    user,
    pr,
    entries: new Map(brainEntries.map((e) => [e.path, e])),
  };
  const statuses = classifyPr(brain, changes);
  process.stdout.write(renderStatus(info, statuses));
}

function parsePrArg(args: readonly string[]): PrNumber {
  const [first] = args;
  if (first === undefined) {
    throw new Error('usage: cabaret status <PR>');
  }
  const n = Number.parseInt(first, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`PR must be a positive integer; got "${first}"`);
  }
  return PrNumber(n);
}

/**
 * Render a status output similar to the CLI sketch in docs/README.md.
 */
export function renderStatus(info: PrInfo, statuses: readonly FileStatus[]): string {
  const lines: string[] = [];
  lines.push(`PR #${String(info.number)} — "${info.title}" by @${info.author}`);
  lines.push(`tip:  ${info.tipCommit}`);
  lines.push(`base: ${info.baseCommit} (${info.baseRef})`);
  lines.push('');

  const labelWidth = 12;
  let attention = 0;
  for (const s of statuses) {
    const label = labelFor(s);
    if (s.kind !== 'reviewed') attention += 1;
    lines.push(`  ${label.padEnd(labelWidth)} ${s.path}`);
  }
  lines.push('');
  if (statuses.length === 0) {
    lines.push('no changed files.');
  } else {
    lines.push(`${String(attention)} of ${String(statuses.length)} file(s) need attention.`);
  }
  return `${lines.join('\n')}\n`;
}

function labelFor(s: FileStatus): string {
  switch (s.kind) {
    case 'reviewed':
      return 'reviewed';
    case 'revUpdate':
      return 'rev-update';
    case 'stale':
      return 'stale';
    case 'unreviewed':
      return 'unreviewed';
  }
}

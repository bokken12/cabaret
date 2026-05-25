#!/usr/bin/env node
import { LocalGitBackend } from '@cabaret/backend';
import { runStatus } from './status.js';
import { runReview, runReviewFile } from './review.js';

async function main(): Promise<void> {
  // TODO(joel for crouton): probably manually parsing argv won't scale that
  // well. Should we look into a library/framework that's not too heavy and is
  // well typed / easy to use?
  const [, , command, ...rest] = process.argv;
  switch (command) {
    case 'status':
      await runStatus(makeBackend(), rest);
      return;
    case 'review':
      await runReview(makeBackend(), rest);
      return;
    case 'review-file':
      await runReviewFile(makeBackend(), rest);
      return;
    case undefined:
    case '-h':
    case '--help':
      printHelp();
      return;
    default:
      process.stderr.write(`cabaret: unknown command "${command}"\n\n`);
      printHelp();
      process.exit(2);
  }
}

function makeBackend(): LocalGitBackend {
  return new LocalGitBackend({ cwd: process.cwd() });
}

function printHelp(): void {
  process.stdout.write(
    [
      'cabaret — diff-based code review for GitHub PRs',
      '',
      'Usage:',
      '  cabaret status <PR>              classify each changed file vs your brain',
      '  cabaret review <PR>              mark every changed file reviewed',
      '  cabaret review-file <PR> <path>  mark a single file reviewed',
      '',
      'Run from inside a git repository whose `origin` points to GitHub.',
      'Requires the `gh` CLI to be installed and authenticated.',
      '',
    ].join('\n'),
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`cabaret: ${message}\n`);
  process.exit(1);
});

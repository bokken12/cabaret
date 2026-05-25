import { BlobSha, CommitSha, type FileState, Path } from '@cabaret/core';
import { exec } from './exec.js';

/**
 * Thin wrapper around the system `git` CLI. Each method shells out and
 * parses git's plumbing output. `cwd` is the repository root.
 */
export class Git {
  constructor(private readonly cwd: string) {}

  async run(args: readonly string[]): Promise<string> {
    const { stdout } = await exec('git', args, { cwd: this.cwd });
    return stdout;
  }

  async config(key: string): Promise<string | null> {
    try {
      return (await this.run(['config', '--get', key])).trim();
    } catch {
      return null;
    }
  }

  /**
   * Locate the repository root from the current cwd. Cabaret operates against
   * the whole repo, not a sub-tree.
   */
  static async findRoot(startingCwd: string): Promise<string> {
    const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: startingCwd });
    return stdout.trim();
  }

  /** Fetch a single ref (e.g. `refs/pull/123/head`) from the named remote. */
  async fetch(remote: string, ref: string): Promise<void> {
    await this.run(['fetch', '--no-tags', '--quiet', remote, ref]);
  }

  /**
   * `git merge-base A B` — the common ancestor of two commits. Cabaret uses
   * this to compute the "base" against which to diff a PR's tip, matching
   * what GitHub displays.
   */
  async mergeBase(a: CommitSha, b: CommitSha): Promise<CommitSha> {
    const out = (await this.run(['merge-base', a, b])).trim();
    if (!out) throw new Error(`merge-base(${a}, ${b}) produced no output`);
    return CommitSha(out);
  }

  /**
   * `git diff-tree --raw -r <base> <tip>` parsed into FileStates. Returns
   * one entry per file added or modified between the two trees.
   *
   * TODO: handle renames (`-M` plus the alternate raw format with two
   * paths per record) and deletions (currently filtered out).
   */
  async diffTree(base: CommitSha, tip: CommitSha): Promise<readonly FileState[]> {
    const out = await this.run([
      'diff-tree',
      '--raw',
      '--no-commit-id',
      '--no-renames',
      '-r',
      '-z',
      '--diff-filter=AM',
      base,
      tip,
    ]);
    return parseDiffTreeRaw(out);
  }
}

/**
 * Parse the `-z`-delimited output of `git diff-tree --raw`. Each record:
 *
 *   `:<old-mode> <new-mode> <old-sha> <new-sha> <status>` then NUL then `<path>` then NUL
 *
 * For `A` (added), `<old-sha>` is all zeros — we surface this as `null`.
 */
export function parseDiffTreeRaw(raw: string): readonly FileState[] {
  if (raw.length === 0) return [];
  // -z output is NUL-separated. We expect alternating <meta-line> and <path>.
  const parts = raw.split('\0').filter((p) => p.length > 0);
  const out: FileState[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const meta = parts[i];
    const path = parts[i + 1];
    if (meta === undefined || path === undefined) {
      throw new Error(`malformed diff-tree output near index ${String(i)}: ${raw.slice(0, 200)}`);
    }
    // meta: ":<old-mode> <new-mode> <old-sha> <new-sha> <status>"
    if (!meta.startsWith(':')) {
      throw new Error(`unexpected diff-tree meta line: ${meta}`);
    }
    const fields = meta.slice(1).split(' ');
    const oldSha = fields[2];
    const newSha = fields[3];
    if (oldSha === undefined || newSha === undefined) {
      throw new Error(`malformed diff-tree meta: ${meta}`);
    }
    out.push({
      path: Path(path),
      baseBlob: isAllZeros(oldSha) ? null : BlobSha(oldSha),
      tipBlob: BlobSha(newSha),
    });
  }
  return out;
}

function isAllZeros(sha: string): boolean {
  return /^0+$/.test(sha);
}

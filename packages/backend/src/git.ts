import { BlobSha, CommitSha, type FileState, Path } from '@cabaret/core';
import { exec, ExecError } from './exec.js';

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
   * Resolve a ref to its commit OID, or return null if the ref doesn't
   * exist. Used by the brain ref reader; missing refs are the normal "no
   * brain yet" case, not an error.
   */
  async revParseRef(ref: string): Promise<CommitSha | null> {
    try {
      const out = (await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim();
      return out ? CommitSha(out) : null;
    } catch (err) {
      // `rev-parse --verify --quiet` exits 1 with empty stderr when the ref
      // is absent. Anything else (e.g. not-a-repo) should surface.
      if (err instanceof ExecError && err.exitCode === 1 && err.stderr.trim() === '') return null;
      throw err;
    }
  }

  /** Write `content` to a new blob object; return its OID. */
  async hashObject(content: string): Promise<BlobSha> {
    const { stdout } = await exec('git', ['hash-object', '-w', '--stdin'], {
      cwd: this.cwd,
      input: content,
    });
    return BlobSha(stdout.trim());
  }

  /**
   * Build a tree containing a single regular-file entry. Suitable for
   * payloads we don't need to subdivide. Returns the tree OID.
   */
  async mkTreeSingleFile(name: string, blob: BlobSha): Promise<string> {
    const entry = `100644 blob ${blob}\t${name}\n`;
    const { stdout } = await exec('git', ['mktree'], { cwd: this.cwd, input: entry });
    return stdout.trim();
  }

  /**
   * Create a commit pointing at `tree`. `parent` is null for the first
   * commit on a ref; otherwise it links back to the previous tip.
   * Author/committer fall through to git's defaults (i.e. `user.email`
   * and `user.name`), which match cabaret's notion of the local user.
   */
  async commitTree(
    tree: string,
    parent: CommitSha | null,
    message: string,
  ): Promise<CommitSha> {
    const args = ['commit-tree', tree, '-m', message];
    if (parent !== null) args.push('-p', parent);
    const { stdout } = await exec('git', args, { cwd: this.cwd });
    return CommitSha(stdout.trim());
  }

  /**
   * Point `ref` at `target`, with a compare-and-swap guard against
   * `expectedCurrent`. Pass `null` to assert the ref does not yet exist
   * (the 40-zero SHA in `update-ref`'s third-argument convention).
   * Concurrent writers therefore fail loudly instead of silently
   * clobbering each other's history.
   */
  async updateRef(ref: string, target: CommitSha, expectedCurrent: CommitSha | null): Promise<void> {
    const zero = '0000000000000000000000000000000000000000';
    await this.run(['update-ref', ref, target, expectedCurrent ?? zero]);
  }

  /**
   * Read a regular file at `path` inside `commit`'s tree, returning its raw
   * content. Throws if the file isn't present in the tree.
   */
  async readFileFromCommit(commit: CommitSha, path: string): Promise<string> {
    return this.run(['show', `${commit}:${path}`]);
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

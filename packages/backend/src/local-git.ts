import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  BlobSha,
  type BrainEntry,
  CommitSha,
  type FileState,
  Path,
  type PrNumber,
  UserId,
} from '@cabaret/core';
import { Git } from './git.js';
import { Gh } from './gh.js';
import type { Backend, PrInfo } from './backend.js';

/**
 * A GitHub repo identifier, derived from `git remote get-url origin`.
 * Used to namespace brain files on disk so two checkouts of different
 * repos don't share state.
 */
type RepoSlug = { readonly owner: string; readonly name: string };

export type LocalGitBackendOptions = {
  /** Repository root (where `.git/` lives). */
  readonly cwd: string;
  /**
   * Override the brain storage directory. Defaults to `~/.cabaret/`.
   * Useful in tests; should not be set by end users.
   */
  readonly brainDir?: string;
};

/**
 * Backend implementation that talks to the local `git` CLI and the local
 * `gh` CLI. Brain state lives as a JSON file under `~/.cabaret/` keyed by
 * (repo, user, PR).
 *
 * TODO: migrate brain storage to git refs (`refs/cabaret/prs/<n>/brain/<user>`)
 * to enable multi-device sync.
 */
export class LocalGitBackend implements Backend {
  private readonly git: Git;
  private readonly gh: Gh;
  private readonly brainRoot: string;
  private cachedRepo: RepoSlug | null = null;
  /** Memoize PrInfo per invocation; `getChangedFiles` calls `getPrInfo` too. */
  private readonly prInfoCache = new Map<number, Promise<PrInfo>>();

  constructor(options: LocalGitBackendOptions) {
    this.git = new Git(options.cwd);
    this.gh = new Gh(options.cwd);
    this.brainRoot = options.brainDir ?? join(homedir(), '.cabaret');
  }

  async currentUser(): Promise<UserId> {
    const email = await this.git.config('user.email');
    if (!email) {
      throw new Error('git config user.email is not set; cabaret needs a user identity');
    }
    return UserId(email);
  }

  getPrInfo(pr: PrNumber): Promise<PrInfo> {
    let cached = this.prInfoCache.get(pr);
    if (!cached) {
      cached = this.fetchPrInfo(pr);
      this.prInfoCache.set(pr, cached);
    }
    return cached;
  }

  private async fetchPrInfo(pr: PrNumber): Promise<PrInfo> {
    const view = await this.gh.prView(pr);
    // Make sure the PR's tip is in the local object database, then compute
    // merge-base against the PR's base ref so subsequent diffs see the
    // commit even if the user has never fetched the PR.
    await this.git.fetch('origin', `pull/${String(pr)}/head`);
    // `baseRefOid` is the tip of the base branch at the moment `gh` ran;
    // merge-base against the PR head gives us the PR's actual base, which
    // is what GitHub displays as the "Files changed" view's left side.
    const baseCommit = await this.git.mergeBase(
      CommitSha(view.baseRefOid),
      CommitSha(view.headRefOid),
    );
    const tipCommit = CommitSha(view.headRefOid);
    return {
      number: pr,
      title: view.title,
      author: view.author.login,
      baseRef: view.baseRefName,
      baseCommit,
      tipCommit,
      url: view.url,
    };
  }

  async getChangedFiles(pr: PrNumber): Promise<readonly FileState[]> {
    const info = await this.getPrInfo(pr);
    return this.git.diffTree(info.baseCommit, info.tipCommit);
  }

  async readBrain(user: UserId, pr: PrNumber): Promise<readonly BrainEntry[]> {
    const path = await this.brainFilePath(user, pr);
    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return parseBrainFile(raw);
  }

  async writeBrain(user: UserId, pr: PrNumber, entries: readonly BrainEntry[]): Promise<void> {
    const path = await this.brainFilePath(user, pr);
    await mkdir(join(path, '..'), { recursive: true });
    const file: BrainFile = {
      schema: 1,
      pr,
      user,
      entries: entries.map((e) => ({
        path: e.path,
        baseBlob: e.baseBlob,
        tipBlob: e.tipBlob,
        markKind: e.markKind,
      })),
    };
    await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, 'utf-8');
  }

  private async brainFilePath(user: UserId, pr: PrNumber): Promise<string> {
    const repo = await this.repo();
    return join(this.brainRoot, `${repo.owner}-${repo.name}`, user, `pr-${String(pr)}.json`);
  }

  private async repo(): Promise<RepoSlug> {
    if (this.cachedRepo) return this.cachedRepo;
    const url = (await this.git.run(['remote', 'get-url', 'origin'])).trim();
    const slug = parseRepoSlug(url);
    this.cachedRepo = slug;
    return slug;
  }
}

/**
 * Parse an `origin` URL like `git@github.com:owner/repo.git` or
 * `https://github.com/owner/repo.git` into `{ owner, name }`. Only GitHub
 * is supported today; other forges should throw.
 */
export function parseRepoSlug(url: string): RepoSlug {
  const match = /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url);
  if (!match) {
    throw new Error(`cannot parse GitHub repo from remote URL: ${url}`);
  }
  const [, owner, name] = match;
  if (owner === undefined || name === undefined) {
    throw new Error(`cannot parse GitHub repo from remote URL: ${url}`);
  }
  return { owner, name };
}

/**
 * Schema for the on-disk brain JSON file. Bump `schema` and add a
 * migration path here when the shape changes.
 */
const BrainFileSchema = z.object({
  schema: z.literal(1),
  pr: z.number(),
  user: z.string(),
  entries: z.array(
    z.object({
      path: z.string(),
      baseBlob: z.string().nullable(),
      tipBlob: z.string(),
      markKind: z.union([z.literal('user'), z.literal('internal')]),
    }),
  ),
});

type BrainFile = z.infer<typeof BrainFileSchema>;

/**
 * Parse a brain JSON file. Brain files are written by cabaret itself, so
 * any schema violation here is a bug and should surface fast.
 */
export function parseBrainFile(raw: string): readonly BrainEntry[] {
  const file = BrainFileSchema.parse(JSON.parse(raw));
  return file.entries.map((e) => ({
    path: Path(e.path),
    baseBlob: e.baseBlob === null ? null : BlobSha(e.baseBlob),
    tipBlob: BlobSha(e.tipBlob),
    markKind: e.markKind,
  }));
}

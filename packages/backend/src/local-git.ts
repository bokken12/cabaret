import { z } from 'zod';
import {
  BlobSha,
  type BrainEntry,
  CommitSha,
  type FileState,
  Path,
  type PrNumber,
  Timestamp,
  UserId,
} from '@cabaret/core';
import { Git } from './git.js';
import { Gh } from './gh.js';
import type { Backend, PrInfo } from './backend.js';

export type LocalGitBackendOptions = {
  /** Repository root (where `.git/` lives). */
  readonly cwd: string;
};

/** Filename of the brain payload inside the ref's tree. */
const BRAIN_FILE = 'brain.json';

/**
 * Backend implementation that talks to the local `git` CLI and the local
 * `gh` CLI. Brain state lives as a commit on
 * `refs/cabaret/users/<user>/prs/<n>`; the commit's tree contains a single
 * `brain.json` file. Multi-device sync is then vanilla `git push`/`git
 * fetch` of that ref.
 */
export class LocalGitBackend implements Backend {
  private readonly git: Git;
  private readonly gh: Gh;
  private commitIdentityChecked = false;
  /** Memoize PrInfo per invocation; `getChangedFiles` calls `getPrInfo` too. */
  private readonly prInfoCache = new Map<number, Promise<PrInfo>>();

  constructor(options: LocalGitBackendOptions) {
    this.git = new Git(options.cwd);
    this.gh = new Gh(options.cwd);
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
    const ref = brainRefName(user, pr);
    const tip = await this.git.revParseRef(ref);
    if (tip === null) return [];
    return parseBrainBlob(await this.git.readFileFromCommit(tip, BRAIN_FILE));
  }

  async writeBrain(user: UserId, pr: PrNumber, entries: readonly BrainEntry[]): Promise<void> {
    await this.ensureCommitIdentity();
    const ref = brainRefName(user, pr);
    const parent = await this.git.revParseRef(ref);
    const payload = serializeBrainBlob(user, pr, entries);
    const blob = await this.git.hashObject(payload);
    const tree = await this.git.mkTreeSingleFile(BRAIN_FILE, blob);
    const message = `cabaret: brain advance for PR #${String(pr)} (${String(entries.length)} entr${entries.length === 1 ? 'y' : 'ies'})`;
    const commit = await this.git.commitTree(tree, parent, message);
    await this.git.updateRef(ref, commit, parent);
  }

  /**
   * `git commit-tree` reads `user.email` and `user.name` from config; if
   * either is missing, it dies with a generic "tell me who you are"
   * error. Surface a cabaret-shaped error up front so the failure is
   * legible, and so it matches the existing `currentUser()` check rather
   * than splitting validation across two surfaces.
   */
  private async ensureCommitIdentity(): Promise<void> {
    if (this.commitIdentityChecked) return;
    const [email, name] = await Promise.all([
      this.git.config('user.email'),
      this.git.config('user.name'),
    ]);
    if (!email) {
      throw new Error('git config user.email is not set; cabaret needs a user identity');
    }
    if (!name) {
      throw new Error('git config user.name is not set; cabaret needs a user identity');
    }
    this.commitIdentityChecked = true;
  }
}

/**
 * Construct the brain ref for a given (user, PR). UserIds in cabaret are
 * git email addresses, which are valid in a single ref component except
 * for a handful of git-disallowed characters; assert defensively rather
 * than silently sanitize so a misconfigured `user.email` surfaces.
 */
export function brainRefName(user: UserId, pr: PrNumber): string {
  if (!isValidRefComponent(user)) {
    throw new Error(`UserId is not safe to use in a git ref: ${user}`);
  }
  return `refs/cabaret/users/${user}/prs/${String(pr)}`;
}

/**
 * Subset of `git check-ref-format` applied to a single component:
 * allow only common email punctuation, and reject the edge cases git
 * rejects (`.foo`, `foo.`, `foo.lock`, `..`, the lone `@`, the empty
 * string). Whitespace and the explicit disallowed chars (`/`, `~`, `^`,
 * `:`, `?`, `*`, `[`, `\`) fall out of the character class.
 */
function isValidRefComponent(s: string): boolean {
  if (s.length === 0 || s === '@') return false;
  if (s.startsWith('.') || s.endsWith('.') || s.endsWith('.lock')) return false;
  if (s.includes('..')) return false;
  return /^[A-Za-z0-9._@+=-]+$/.test(s);
}

/**
 * Wire schema for the brain payload stored as `brain.json` in the ref's
 * tree. Bump the literal and add a parallel parser when the shape
 * changes; refs always carry the latest schema, never an older one.
 */
const BrainBlobSchema = z.object({
  schema: z.literal(1),
  pr: z.number(),
  user: z.string(),
  entries: z.array(
    z.object({
      path: z.string(),
      baseBlob: z.string().nullable(),
      tipBlob: z.string(),
      markKind: z.union([z.literal('user'), z.literal('internal')]),
      lastModifiedAt: z.number(),
    }),
  ),
});

/** Parse a `brain.json` blob from the ref's tree. */
export function parseBrainBlob(raw: string): readonly BrainEntry[] {
  const file = BrainBlobSchema.parse(JSON.parse(raw));
  return file.entries.map((e) => ({
    path: Path(e.path),
    baseBlob: e.baseBlob === null ? null : BlobSha(e.baseBlob),
    tipBlob: BlobSha(e.tipBlob),
    markKind: e.markKind,
    lastModifiedAt: Timestamp(e.lastModifiedAt),
  }));
}

/** Serialize entries into the `brain.json` payload. */
export function serializeBrainBlob(
  user: UserId,
  pr: PrNumber,
  entries: readonly BrainEntry[],
): string {
  const payload: z.infer<typeof BrainBlobSchema> = {
    schema: 1,
    pr,
    user,
    entries: entries.map((e) => ({
      path: e.path,
      baseBlob: e.baseBlob,
      tipBlob: e.tipBlob,
      markKind: e.markKind,
      lastModifiedAt: e.lastModifiedAt,
    })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

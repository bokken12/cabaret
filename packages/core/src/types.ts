/**
 * Core domain types.
 *
 * Branded primitives prevent accidental mixing of structurally identical
 * strings/numbers (a BlobSha is not interchangeable with a CommitSha or an
 * arbitrary string). Constructors live alongside their types; runtime
 * validation belongs at I/O boundaries (e.g. parsing git output) and lives
 * in the `backend` package.
 */

declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type BlobSha = Brand<string, 'BlobSha'>;
export type CommitSha = Brand<string, 'CommitSha'>;
export type Path = Brand<string, 'Path'>;
export type PrNumber = Brand<number, 'PrNumber'>;
export type UserId = Brand<string, 'UserId'>;

export const BlobSha = (s: string): BlobSha => s as BlobSha;
export const CommitSha = (s: string): CommitSha => s as CommitSha;
export const Path = (s: string): Path => s as Path;
export const PrNumber = (n: number): PrNumber => n as PrNumber;
export const UserId = (s: string): UserId => s as UserId;

/**
 * How a brain entry was advanced.
 *
 * - `user`: the reviewer explicitly accepted this state.
 * - `internal`: the brain advanced without a human looking (e.g. a rev-update
 *   after a rebase that didn't change the file's contribution). Iron calls
 *   this `Internal__fully_reviewed` and uses the distinction for catch-up.
 */
export type MarkKind = 'user' | 'internal';

/**
 * A single per-(user, PR, path) review state.
 *
 * The pair `(baseBlob, tipBlob)` is the diff the reviewer last accepted. It
 * is content-addressed: comparing pairs to a PR's current `(base, tip)`
 * tells us what changed since the user last looked, independent of commit
 * SHAs (so rebases and force-pushes pass through cleanly).
 */
export type BrainEntry = {
  readonly path: Path;
  readonly baseBlob: BlobSha;
  readonly tipBlob: BlobSha;
  readonly markKind: MarkKind;
};

/**
 * A user's review state for one PR.
 */
export type Brain = {
  readonly user: UserId;
  readonly pr: PrNumber;
  readonly entries: ReadonlyMap<Path, BrainEntry>;
};

/**
 * The diff from base to tip for one file.
 */
export type Diff2 = {
  readonly path: Path;
  readonly baseBlob: BlobSha;
  readonly tipBlob: BlobSha;
};

/**
 * A diamond: the change between `(oldBase, oldTip)` (what the reviewer
 * accepted) and `(newBase, newTip)` (what the PR now presents). This is the
 * unit cabaret renders to a reviewer when the brain doesn't already match
 * the PR's current state for a file.
 */
export type Diff4 = {
  readonly path: Path;
  readonly oldBase: BlobSha;
  readonly oldTip: BlobSha;
  readonly newBase: BlobSha;
  readonly newTip: BlobSha;
};

/**
 * The classification of a single file in a PR with respect to a reviewer's
 * brain. Discriminated union — exhaustive `switch` on `kind` is the
 * intended consumption pattern.
 *
 * - `reviewed`: brain entry equals the PR's current `(base, tip)`. Nothing
 *   to show.
 * - `revUpdate`: brain entry can be advanced silently because the PR's
 *   contribution to this file is unchanged (typical after a rebase). The
 *   `diff4` field carries the four-blob diamond so the caller can verify or
 *   record the auto-advance.
 * - `stale`: the brain has an entry but the PR has moved meaningfully. The
 *   reviewer should see the `diff4`.
 * - `unreviewed`: the brain has no entry for this path. Show the `diff2`.
 */
export type FileStatus =
  | { readonly kind: 'reviewed'; readonly path: Path }
  | { readonly kind: 'revUpdate'; readonly path: Path; readonly diff4: Diff4 }
  | { readonly kind: 'stale'; readonly path: Path; readonly diff4: Diff4 }
  | { readonly kind: 'unreviewed'; readonly path: Path; readonly diff2: Diff2 };

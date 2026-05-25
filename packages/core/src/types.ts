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
 * The state of one file in a PR (current PR view) or in a reviewer's brain
 * (what they last saw). `baseBlob` is `null` for files added by the PR
 * (i.e. absent from the merge-base tree). Deletions are not represented in
 * milestone 1 — `tipBlob` is always present. Renames are TODO.
 */
export type FileState = {
  readonly path: Path;
  readonly baseBlob: BlobSha | null;
  readonly tipBlob: BlobSha;
};

/**
 * A single per-(user, PR, path) review state. The `(baseBlob, tipBlob)`
 * pair is the diff the reviewer last accepted; content addressing makes
 * comparisons against the PR's current pair survive rebases and
 * force-pushes.
 */
export type BrainEntry = FileState & {
  readonly markKind: MarkKind;
};

/**
 * A user's review state for one PR. The entries map is keyed by path; each
 * file's state is independent of every other file's.
 */
export type Brain = {
  readonly user: UserId;
  readonly pr: PrNumber;
  readonly entries: ReadonlyMap<Path, BrainEntry>;
};

/**
 * The diff from base to tip for one file. Same shape as FileState; named
 * separately so signatures that *mean* "a base→tip diff" read clearly.
 */
export type Diff2 = FileState;

/**
 * A diamond: the change between `(oldBase, oldTip)` (what the reviewer
 * accepted) and `(newBase, newTip)` (what the PR now presents). This is
 * the unit cabaret renders to a reviewer when the brain doesn't already
 * match the PR's current state for a file.
 */
export type Diff4 = {
  readonly path: Path;
  readonly oldBase: BlobSha | null;
  readonly oldTip: BlobSha;
  readonly newBase: BlobSha | null;
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
 *   `diff4` field carries the four-blob diamond so the caller can verify
 *   or record the auto-advance.
 * - `stale`: the brain has an entry but the PR has moved meaningfully.
 *   The reviewer should see the `diff4`.
 * - `unreviewed`: the brain has no entry for this path. Show the `diff2`.
 */
export type FileStatus =
  | { readonly kind: 'reviewed'; readonly path: Path }
  | { readonly kind: 'revUpdate'; readonly path: Path; readonly diff4: Diff4 }
  | { readonly kind: 'stale'; readonly path: Path; readonly diff4: Diff4 }
  | { readonly kind: 'unreviewed'; readonly path: Path; readonly diff2: Diff2 };
